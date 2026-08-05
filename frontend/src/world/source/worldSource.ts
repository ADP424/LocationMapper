/**
 * Opening a world folder.
 *
 * A browser cannot walk from a picked `level.dat` to its sibling `region/`
 * directory — one file input yields exactly one file. Picking the *folder* is
 * the only way to get the whole world in a single gesture, so that is what this
 * exposes. `level.dat` is then read from inside the folder rather than being
 * the thing the user picks.
 *
 * Two backends, same shape out:
 *   - File System Access API (`showDirectoryPicker`) on Chromium
 *   - `<input webkitdirectory>` everywhere else
 */

import { parseRegionName } from '../anvil/region';
import { parseLevelDat, type LevelInfo } from './levelDat';

/** A region file we know about but have not necessarily read. */
export interface RegionRef {
  rx: number;
  rz: number;
  name: string;
  size: number;
  /** The 8 KiB header only — enough to list which chunks exist. */
  header(): Promise<Uint8Array>;
  bytes(): Promise<Uint8Array>;
}

export interface DimensionRef {
  /** Namespaced id, e.g. `minecraft:overworld`. */
  id: string;
  label: string;
  /** Path of the region directory relative to the world folder. */
  path: string;
  regions: RegionRef[];
}

/**
 * What the folder walk actually saw.
 *
 * "No region files found" is useless on its own — it cannot distinguish a wrong
 * folder from a walk that never ran. This records enough to tell them apart
 * without another round trip.
 */
export interface ScanTrace {
  backend: 'file-system-access' | 'directory-input' | 'local-path';
  directories: number;
  files: number;
  mca: number;
  /** Directories skipped by name, so an over-eager filter is visible. */
  skipped: string[];
  /** First handful of paths seen, whatever they were. */
  sample: string[];
  /** Entries that threw while being read. */
  errors: string[];
}

export interface WorldSource {
  label: string;
  level: LevelInfo | null;
  /** Why level.dat could not be read, when it could not. */
  levelError: string;
  dimensions: DimensionRef[];
  trace: ScanTrace;
}

function newTrace(backend: ScanTrace['backend']): ScanTrace {
  return { backend, directories: 0, files: 0, mca: 0, skipped: [], sample: [], errors: [] };
}

/* ------------------------------------------------------- dimension naming */

const VANILLA_LABELS: Record<string, string> = {
  'minecraft:overworld': 'Overworld',
  'minecraft:the_nether': 'Nether',
  'minecraft:the_end': 'The End'
};

/**
 * Work out which dimension a region directory belongs to.
 *
 * Four layouts exist in the wild:
 *   region/                              overworld
 *   DIM-1/region/                        nether
 *   DIM1/region/                         end
 *   dimensions/<namespace>/<path>/region custom, and what most world
 *                                        generators emit even for the overworld
 */
function dimensionFor(regionDirPath: string): { id: string; label: string } {
  const parts = regionDirPath.split('/').filter(Boolean);
  parts.pop(); // drop the trailing "region"

  if (parts.length === 0) return { id: 'minecraft:overworld', label: 'Overworld' };

  const last = parts[parts.length - 1];
  if (last === 'DIM-1') return { id: 'minecraft:the_nether', label: 'Nether' };
  if (last === 'DIM1') return { id: 'minecraft:the_end', label: 'The End' };

  const at = parts.indexOf('dimensions');
  if (at >= 0 && parts.length >= at + 3) {
    const namespace = parts[at + 1];
    const path = parts.slice(at + 2).join('/');
    const id = `${namespace}:${path}`;
    return { id, label: VANILLA_LABELS[id] ?? `${namespace}:${path}` };
  }

  return { id: parts.join('/'), label: parts.join('/') };
}

/* ----------------------------------------------------------- assembly */

interface DiscoveredFile {
  /** Path relative to the world folder, forward slashes, no leading slash. */
  path: string;
  size: number;
  header(): Promise<Uint8Array>;
  bytes(): Promise<Uint8Array>;
}

function groupIntoDimensions(files: DiscoveredFile[]): DimensionRef[] {
  const byDir = new Map<string, RegionRef[]>();

  for (const file of files) {
    const slash = file.path.lastIndexOf('/');
    const dir = slash < 0 ? '' : file.path.slice(0, slash);
    const name = file.path.slice(slash + 1);
    if (!dir.endsWith('region')) continue;

    const coords = parseRegionName(name);
    if (!coords) continue;

    const list = byDir.get(dir) ?? [];
    list.push({
      rx: coords.rx,
      rz: coords.rz,
      name,
      size: file.size,
      header: file.header,
      bytes: file.bytes
    });
    byDir.set(dir, list);
  }

  const out: DimensionRef[] = [];
  for (const [dir, regions] of byDir) {
    const { id, label } = dimensionFor(dir);
    regions.sort((a, b) => a.rz - b.rz || a.rx - b.rx);
    out.push({ id, label, path: dir || 'region', regions });
  }

  /* Overworld first, then whatever else, biggest first — the useful default
     for a picker is almost always the dimension with the most content. */
  out.sort((a, b) => {
    if (a.id === 'minecraft:overworld') return -1;
    if (b.id === 'minecraft:overworld') return 1;
    return b.regions.length - a.regions.length;
  });
  return out;
}

async function assemble(
  label: string,
  files: DiscoveredFile[],
  levelDat: DiscoveredFile | undefined,
  trace: ScanTrace
): Promise<WorldSource> {
  let level: LevelInfo | null = null;
  let levelError = '';

  if (levelDat) {
    try {
      level = await parseLevelDat(await levelDat.bytes());
    } catch (e) {
      levelError = `level.dat could not be read: ${e instanceof Error ? e.message : String(e)}`;
    }
  } else {
    levelError = 'No level.dat in this folder — spawn point and version unknown.';
  }

  return { label, level, levelError, dimensions: groupIntoDimensions(files), trace };
}

const HEADER_BYTES = 8192;

function fromFile(file: File, path: string): DiscoveredFile {
  return {
    path,
    size: file.size,
    header: async () => new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer()),
    bytes: async () => new Uint8Array(await file.arrayBuffer())
  };
}

/* -------------------------------------------- File System Access backend */

interface DirectoryHandle {
  name: string;
  entries(): AsyncIterableIterator<[string, DirectoryHandle | FileHandle]>;
  kind: 'directory';
}
interface FileHandle {
  name: string;
  kind: 'file';
  getFile(): Promise<File>;
}

/**
 * Generous, because the cost of being too shallow is silent failure.
 *
 * A world folder needs 4 (`dimensions/<ns>/<path>/region`), but people pick the
 * server root, or the extracted-zip folder that contains the server root, and
 * each of those adds a level. SKIP_DIRS is what actually bounds the walk.
 */
const MAX_DEPTH = 10;

/**
 * Directories that never contain region files.
 *
 * Partly speed, partly damage control: if someone picks a server root rather
 * than the world folder, `libraries/` alone is thousands of nested jars and the
 * walk appears to hang. Skipping them means a wrong pick fails fast instead.
 */
const SKIP_DIRS = new Set([
  'playerdata',
  'stats',
  'advancements',
  'datapacks',
  'serverconfig',
  'generated',
  'icons',
  'backups',
  'libraries',
  'versions',
  'cache',
  'plugins',
  'logs',
  'crash-reports',
  'venv',
  'node_modules',
  '.git'
]);

export function canPickDirectory(): boolean {
  return typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

async function walk(
  dir: DirectoryHandle,
  prefix: string,
  depth: number,
  out: DiscoveredFile[],
  found: { levelDat?: DiscoveredFile },
  trace: ScanTrace
) {
  if (depth > MAX_DEPTH) return;
  trace.directories++;

  for await (const [name, handle] of dir.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (trace.sample.length < 30) trace.sample.push(`${handle.kind === 'directory' ? 'd' : '-'} ${path}`);

    try {
      if (handle.kind === 'directory') {
        if (SKIP_DIRS.has(name)) {
          trace.skipped.push(path);
          continue;
        }
        await walk(handle, path, depth + 1, out, found, trace);
        continue;
      }

      trace.files++;
      if (name.endsWith('.mca')) {
        trace.mca++;
        out.push(fromFile(await handle.getFile(), path));
      } else if (name === 'level.dat' && !found.levelDat) {
        found.levelDat = fromFile(await handle.getFile(), path);
      }
    } catch (e) {
      /* One unreadable entry must not abort the whole world. */
      trace.errors.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** Prompt for a world folder. Chromium only — guard with `canPickDirectory`. */
export async function pickWorldDirectory(): Promise<WorldSource> {
  const picker = (window as unknown as {
    showDirectoryPicker(options?: { mode?: string }): Promise<DirectoryHandle>;
  }).showDirectoryPicker;

  const root = await picker({ mode: 'read' });
  const files: DiscoveredFile[] = [];
  const found: { levelDat?: DiscoveredFile } = {};
  const trace = newTrace('file-system-access');
  await walk(root, '', 0, files, found, trace);
  return assemble(root.name, files, found.levelDat, trace);
}

/* ------------------------------------------------ <input webkitdirectory> */

/**
 * Same result from a directory `<input>`, for browsers without the File System
 * Access API. `webkitRelativePath` includes the picked folder as its first
 * segment, which is stripped so both backends produce identical paths.
 */
export async function fromDirectoryInput(fileList: FileList): Promise<WorldSource> {
  const files: DiscoveredFile[] = [];
  const trace = newTrace('directory-input');
  let levelDat: DiscoveredFile | undefined;
  let label = 'world';

  for (const file of Array.from(fileList)) {
    const relative = file.webkitRelativePath || file.name;
    const segments = relative.split('/');
    if (segments.length > 1) label = segments[0];
    const path = segments.slice(1).join('/') || file.name;

    trace.files++;
    if (trace.sample.length < 30) trace.sample.push(`- ${path}`);

    if (file.name.endsWith('.mca')) {
      trace.mca++;
      files.push(fromFile(file, path));
    } else if (file.name === 'level.dat' && !levelDat) {
      levelDat = fromFile(file, path);
    }
  }

  return assemble(label, files, levelDat, trace);
}

/* ------------------------------------------------------ local path (dev) */

interface IndexResponse {
  label: string;
  files: Array<{ path: string; size: number }>;
  error?: string;
}

/**
 * Read a world straight off the dev server's disk, bypassing the browser
 * pickers entirely.
 *
 * The pickers vary by browser and hinge on a permission prompt; during
 * development the world is on the same machine as the dev server, so there is
 * no reason to route it through the browser's file sandbox at all. Only works
 * under `vite dev`, where the `/__world` middleware exists.
 */
export async function fromLocalPath(root: string): Promise<WorldSource> {
  const trace = newTrace('local-path');

  const indexUrl = `/__world/index?root=${encodeURIComponent(root)}`;
  const response = await fetch(indexUrl);
  const index = (await response.json()) as IndexResponse;

  if (!response.ok || index.error) {
    throw new Error(index.error ?? `Could not read ${root} (HTTP ${response.status})`);
  }

  const fetchBytes = async (path: string, max = 0) => {
    const url =
      `/__world/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}` +
      (max ? `&max=${max}` : '');
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Could not read ${path} (HTTP ${r.status})`);
    return new Uint8Array(await r.arrayBuffer());
  };

  const files: DiscoveredFile[] = [];
  let levelDat: DiscoveredFile | undefined;

  for (const entry of index.files) {
    trace.files++;
    if (trace.sample.length < 30) trace.sample.push(`- ${entry.path}`);

    const discovered: DiscoveredFile = {
      path: entry.path,
      size: entry.size,
      header: () => fetchBytes(entry.path, HEADER_BYTES),
      bytes: () => fetchBytes(entry.path)
    };

    if (entry.path.endsWith('.mca')) {
      trace.mca++;
      files.push(discovered);
    } else if (entry.path.endsWith('level.dat') && !levelDat) {
      levelDat = discovered;
    }
  }

  return assemble(index.label, files, levelDat, trace);
}
