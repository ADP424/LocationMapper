import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';

/**
 * Dev-only: serve a Minecraft world straight off disk.
 *
 * The browser folder pickers are a minefield — `showDirectoryPicker` is
 * Chromium-only, the `webkitdirectory` fallback behaves differently per browser,
 * and both depend on a permission prompt. For a development spike, none of that
 * is worth fighting: the world is already on the same machine as the dev server,
 * so the dev server can just read it.
 *
 *   GET /__world/index?root=<absolute path>   discovered level.dat + region files
 *   GET /__world/file?root=..&path=..&max=N   file bytes, optionally first N only
 *
 * Never runs in a production build — `configureServer` only exists for `vite dev`.
 */

const SKIP_DIRS = new Set([
  'playerdata', 'stats', 'advancements', 'datapacks', 'serverconfig', 'generated',
  'icons', 'backups', 'libraries', 'versions', 'cache', 'plugins', 'logs',
  'crash-reports', 'venv', 'node_modules', '.git'
]);

const MAX_DEPTH = 10;

interface FoundFile {
  path: string;
  size: number;
}

async function walk(dir: string, prefix: string, depth: number, out: FoundFile[]) {
  if (depth > MAX_DEPTH) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory costs that subtree, not the whole scan
  }

  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(join(dir, entry.name), path, depth + 1, out);
      continue;
    }
    if (!entry.name.endsWith('.mca') && entry.name !== 'level.dat') continue;
    try {
      out.push({ path, size: (await stat(join(dir, entry.name))).size });
    } catch {
      /* skip a file that vanished mid-scan */
    }
  }
}

/**
 * Reject anything that escapes the declared root.
 *
 * This only ever listens on a local dev server, but a path parameter that walks
 * out of its root with `..` is the kind of thing that should never work even
 * once, regardless of who can reach it.
 */
function safeJoin(root: string, relative: string): string | null {
  const base = resolve(root);
  const target = resolve(base, relative);
  return target === base || target.startsWith(base + sep) ? target : null;
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function localWorldServer(): Plugin {
  return {
    name: 'local-world-server',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/__world/index', (req, res) => {
        void (async () => {
          const url = new URL(req.url ?? '', 'http://localhost');
          const root = url.searchParams.get('root');
          if (!root) return json(res, 400, { error: 'missing ?root=' });

          try {
            const info = await stat(root);
            if (!info.isDirectory()) return json(res, 400, { error: `${root} is not a directory` });
          } catch {
            return json(res, 404, { error: `No such folder: ${root}` });
          }

          const files: FoundFile[] = [];
          await walk(resolve(root), '', 0, files);
          json(res, 200, { label: resolve(root).split(sep).pop() ?? 'world', files });
        })();
      });

      server.middlewares.use('/__world/file', (req, res) => {
        void (async () => {
          const url = new URL(req.url ?? '', 'http://localhost');
          const root = url.searchParams.get('root');
          const path = url.searchParams.get('path');
          if (!root || !path) return json(res, 400, { error: 'missing ?root= or ?path=' });

          const target = safeJoin(root, path);
          if (!target) return json(res, 403, { error: 'path escapes root' });

          try {
            const max = Number(url.searchParams.get('max')) || 0;
            const bytes = await readFile(target);
            const body = max > 0 ? bytes.subarray(0, max) : bytes;
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Length', String(body.byteLength));
            res.end(body);
          } catch (e) {
            json(res, 404, { error: e instanceof Error ? e.message : String(e) });
          }
        })();
      });
    }
  };
}

export default defineConfig({
  plugins: [react(), localWorldServer()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_PROXY_TARGET ?? 'http://localhost:4000',
        changeOrigin: true
      } as never
    }
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 2500 }
});
