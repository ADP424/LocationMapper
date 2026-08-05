/**
 * Diagnose a region file that will not load.
 *
 *   npm run inspect -- path/to/r.0.0.mca
 *   npm run inspect -- path/to/region/          (every .mca in the folder)
 *
 * Works below the parser: it reads the container and the raw NBT, and reports
 * what is actually in the file, so an unsupported world explains itself instead
 * of just failing. Deliberately tolerant — nothing here throws on bad input.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { isRenderable, parseChunk } from '../src/world/anvil/chunk';
import { AnvilError, MIN_DATA_VERSION } from '../src/world/anvil/errors';
import {
  asCompound,
  asList,
  asNumber,
  asString,
  parseNbt,
  type NbtCompound
} from '../src/world/anvil/nbt';
import { parseRegionName, RegionFile } from '../src/world/anvil/region';

const target = process.argv[2];
if (!target) {
  console.error('usage: npm run inspect -- <file.mca | region-directory>');
  process.exit(2);
}

const n = (v: number) => v.toLocaleString();

function heading(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

function row(label: string, value: string, note = '') {
  console.log(`  ${label.padEnd(22)} ${String(value).padStart(12)}${note ? `   \x1b[2m${note}\x1b[0m` : ''}`);
}

/** Counts of a value, printed most common first. */
class Tally {
  private readonly counts = new Map<string, number>();

  add(key: string) {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  get size() {
    return this.counts.size;
  }

  top(limit = 8): Array<[string, number]> {
    return [...this.counts].sort((a, b) => b[1] - a[1]).slice(0, limit);
  }
}

interface Findings {
  chunks: number;
  read: number;
  containerErrors: Tally;
  rootKeys: Tally;
  dataVersions: Tally;
  statuses: Tally;
  parseErrors: Tally;
  parsed: number;
  renderable: number;
  sectionCounts: number[];
  blockNames: Tally;
  legacy: number;
  emptySections: number;
}

function blank(): Findings {
  return {
    chunks: 0,
    read: 0,
    containerErrors: new Tally(),
    rootKeys: new Tally(),
    dataVersions: new Tally(),
    statuses: new Tally(),
    parseErrors: new Tally(),
    parsed: 0,
    renderable: 0,
    sectionCounts: [],
    blockNames: new Tally(),
    legacy: 0,
    emptySections: 0
  };
}

/** Read raw NBT structure without going through the strict parser. */
function describeRaw(root: NbtCompound, f: Findings) {
  for (const key of Object.keys(root)) f.rootKeys.add(key);

  const level = asCompound(root.Level);
  if (level) {
    f.legacy++;
    /* The old layout keeps its own Status and section list inside Level. */
    f.statuses.add(asString(level.Status) ?? '(none)');
    const legacySections = asList(level.Sections);
    f.sectionCounts.push(legacySections?.length ?? 0);
    return;
  }

  f.statuses.add(asString(root.Status) ?? '(none)');

  const sections = asList(root.sections) ?? [];
  let nonEmpty = 0;
  for (const raw of sections) {
    const s = asCompound(raw);
    if (!s) continue;
    const states = asCompound(s.block_states);
    const palette = states ? asList(states.palette) : undefined;
    if (!palette || palette.length === 0) continue;
    nonEmpty++;
    for (const entry of palette) {
      const name = asString(asCompound(entry)?.Name ?? undefined);
      if (name) f.blockNames.add(name);
    }
  }
  f.sectionCounts.push(nonEmpty);
  if (nonEmpty === 0) f.emptySections++;
}

async function inspectFile(path: string, name: string): Promise<Findings> {
  const f = blank();
  const bytes = new Uint8Array(await readFile(path));

  const coords = parseRegionName(name);
  heading(`${name}  (${(bytes.length / 1024 / 1024).toFixed(2)} MB)`);
  if (coords) {
    const bx = coords.rx * 512;
    const bz = coords.rz * 512;
    row('region', `${coords.rx}, ${coords.rz}`, `blocks x ${bx}..${bx + 511}, z ${bz}..${bz + 511}`);
  } else {
    row('name', name, 'does not match r.<x>.<z>.mca — is this a region file?');
  }

  let region: RegionFile;
  try {
    region = new RegionFile(bytes, coords?.rx ?? 0, coords?.rz ?? 0);
  } catch (e) {
    console.log(`  \x1b[31m${e instanceof Error ? e.message : String(e)}\x1b[0m`);
    return f;
  }

  const slots = region.slots();
  f.chunks = slots.length;
  row('chunks in header', n(slots.length));
  if (slots.length === 0) {
    console.log('  \x1b[31mHeader lists no chunks — the file has a header but no chunk data.\x1b[0m');
    return f;
  }

  for (const slot of slots) {
    let nbt: Uint8Array | null;
    try {
      nbt = await region.readChunk(slot.lx, slot.lz);
    } catch (e) {
      f.containerErrors.add(e instanceof AnvilError ? `${e.code}: ${e.message}` : String(e));
      continue;
    }
    if (!nbt) continue;
    f.read++;

    try {
      const { value: root } = parseNbt(nbt);
      f.dataVersions.add(String(asNumber(root.DataVersion) ?? '(none)'));
      describeRaw(root, f);
    } catch (e) {
      f.parseErrors.add(`nbt: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    try {
      const chunk = parseChunk(nbt);
      f.parsed++;
      if (isRenderable(chunk)) f.renderable++;
    } catch (e) {
      f.parseErrors.add(e instanceof AnvilError ? e.code : `other: ${String(e)}`);
    }
  }

  /* ------------------------------------------------------------- report */

  row('chunks read', n(f.read));
  row('parsed by our reader', n(f.parsed), f.parsed === f.read ? '' : 'see errors below');
  row('renderable', n(f.renderable));

  if (f.sectionCounts.length) {
    const total = f.sectionCounts.reduce((a, b) => a + b, 0);
    const max = Math.max(...f.sectionCounts);
    row('sections per chunk', (total / f.sectionCounts.length).toFixed(1), `max ${max}`);
  }
  if (f.emptySections) row('chunks with 0 sections', n(f.emptySections), 'nothing to draw');

  console.log(`  ${'root tags'.padEnd(22)} ${f.rootKeys.top(12).map(([k]) => k).join(', ')}`);
  console.log(
    `  ${'DataVersion'.padEnd(22)} ${f.dataVersions
      .top(4)
      .map(([v, c]) => `${v} (${c})`)
      .join(', ')}`
  );
  console.log(
    `  ${'Status'.padEnd(22)} ${f.statuses
      .top(4)
      .map(([v, c]) => `${v} (${c})`)
      .join(', ')}`
  );

  if (f.blockNames.size) {
    heading('  Most common blocks');
    for (const [name, count] of f.blockNames.top(10)) {
      console.log(`    ${name.padEnd(38)} ${String(count).padStart(6)} palette entries`);
    }
  }

  if (f.containerErrors.size) {
    heading('  Container errors');
    for (const [msg, count] of f.containerErrors.top(5)) {
      console.log(`    \x1b[31m${count}x\x1b[0m ${msg}`);
    }
  }

  if (f.parseErrors.size) {
    heading('  Parse errors');
    for (const [msg, count] of f.parseErrors.top(5)) {
      console.log(`    \x1b[31m${count}x\x1b[0m ${msg}`);
    }
  }

  /* ------------------------------------------------------------ verdict */

  heading('  Verdict');
  if (f.renderable > 0) {
    console.log(`    \x1b[32m${n(f.renderable)} chunks will import.\x1b[0m`);
  } else if (f.legacy > 0) {
    console.log(
      `    \x1b[33mPre-1.18 chunk layout.\x1b[0m ${n(f.legacy)} chunks nest everything under a\n` +
        `    \`Level\` compound with \`Sections\`/\`Palette\`/\`BlockStates\`. This reader wants the\n` +
        `    1.18+ layout: \`sections\` at the root, \`block_states.palette\`, DataVersion >= ${MIN_DATA_VERSION}.\n` +
        `    Whatever wrote these regions targets the old format — Python's anvil-parser is the\n` +
        `    usual culprit. Either point it at a 1.18+ writer, or open the world once in a\n` +
        `    modern client so Minecraft rewrites the chunks.`
    );
  } else if (f.emptySections === f.read && f.read > 0) {
    console.log(
      '    \x1b[33mChunks exist but contain no block sections.\x1b[0m The generator wrote chunk\n' +
        '    entries without terrain, so there is genuinely nothing to draw.'
    );
  } else if (f.read === 0) {
    console.log('    \x1b[31mNo chunk data could be read out of the container.\x1b[0m');
  } else {
    console.log('    \x1b[31mChunks read but none renderable — see the errors above.\x1b[0m');
  }

  return f;
}

/* ----------------------------------------------------------------- main */

const info = await stat(target);
if (info.isDirectory()) {
  const names = (await readdir(target)).filter((x) => x.endsWith('.mca')).sort();
  if (names.length === 0) {
    console.error(`No .mca files in ${target}`);
    process.exit(1);
  }
  console.log(`${names.length} region file${names.length === 1 ? '' : 's'} in ${target}`);
  for (const name of names.slice(0, 8)) await inspectFile(join(target, name), name);
  if (names.length > 8) console.log(`\n\x1b[2m…and ${names.length - 8} more\x1b[0m`);
} else {
  await inspectFile(target, target.split(/[\\/]/).pop()!);
}

console.log('');
