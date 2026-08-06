/**
 * Every distinct block name in a world, and how the colour table resolves it.
 *
 * The colour table can only be judged against a real world. "Unknown" blocks
 * draw magenta and are obvious; blocks that merely land on a family heuristic
 * are the quieter problem — they render, in roughly the wrong colour, and the
 * only way to find them is to enumerate what a world actually contains.
 *
 * Palettes are read straight out of the section NBT, so this costs one
 * decompress per chunk and no block unpacking at all.
 *
 *   npm run census -- <world folder> [regions]
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { heuristicBlockNames, matchKindOf, unknownBlockNames } from '../src/world/anvil/blocks';
import { asCompound, asList, asNumber, asString, parseNbt } from '../src/world/anvil/nbt';
import { RegionFile } from '../src/world/anvil/region';

const root = process.argv[2];
if (!root) {
  console.error('usage: npm run census -- <world folder> [max regions]');
  process.exit(1);
}
const maxRegions = Number(process.argv[3]) || 40;

const n = (v: number) => v.toLocaleString();

/** Every `region/` directory under the world folder, at any depth. */
async function findRegionFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > 6) return [];
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await findRegionFiles(path, depth + 1)));
    else if (e.name.endsWith('.mca')) out.push(path);
  }
  return out;
}

const files = (await findRegionFiles(root)).sort();
if (files.length === 0) {
  console.error(`No .mca files under ${root}`);
  process.exit(1);
}

/* Spread the sample across the world rather than taking the first N files
   alphabetically, which would only ever see one corner of it. */
const stride = Math.max(1, Math.floor(files.length / maxRegions));
const sample = files.filter((_, i) => i % stride === 0).slice(0, maxRegions);

console.log(`${files.length} region files, sampling ${sample.length}\n`);

const counts = new Map<string, number>();
let chunks = 0;
let failed = 0;

const t0 = performance.now();

for (const [i, path] of sample.entries()) {
  process.stdout.write(`\r  ${i + 1}/${sample.length}  ${chunks} chunks`);
  let region: RegionFile;
  try {
    region = new RegionFile(new Uint8Array(await readFile(path)));
  } catch {
    failed++;
    continue;
  }

  for (const slot of region.slots()) {
    try {
      const nbt = await region.readChunk(slot.lx, slot.lz);
      if (!nbt) continue;
      const { value: chunk } = parseNbt(nbt);
      if (asNumber(chunk.DataVersion) === undefined) continue;
      chunks++;

      for (const raw of asList(chunk.sections) ?? []) {
        const section = asCompound(raw);
        const states = section && asCompound(section.block_states);
        if (!states) continue;
        for (const entry of asList(states.palette) ?? []) {
          const name = asString(asCompound(entry)?.Name);
          if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
        }
      }
    } catch {
      failed++;
    }
  }
}

console.log(`\r  read ${n(chunks)} chunks in ${((performance.now() - t0) / 1000).toFixed(1)} s${
  failed ? `, ${failed} failed` : ''
}\n`);

/* Palette appearances, not block counts: a name in many palettes is common in
   the world, which is the ordering that matters for what to fix first. */
const byUse = [...counts].sort((a, b) => b[1] - a[1]);
const tally = { exact: 0, heuristic: 0, skipped: 0, unknown: 0 };
for (const [name] of byUse) tally[matchKindOf(name)]++;

console.log(`\x1b[1mCoverage of ${n(counts.size)} distinct block names\x1b[0m`);
for (const [kind, count] of Object.entries(tally)) {
  console.log(`  ${kind.padEnd(12)} ${String(count).padStart(5)}`);
}

const unknown = new Set(unknownBlockNames());
const heuristic = new Set(heuristicBlockNames());

function list(title: string, names: Set<string>, colour: string) {
  const rows = byUse.filter(([name]) => names.has(name));
  if (rows.length === 0) return;
  console.log(`\n\x1b[1m${title}\x1b[0m  \x1b[2m(sections using it)\x1b[0m`);
  for (const [name, count] of rows) {
    console.log(`  ${colour}${name.replace(/^minecraft:/, '').padEnd(38)}\x1b[0m ${n(count).padStart(8)}`);
  }
}

list('Unknown — drawn magenta', unknown, '\x1b[35m');
list('Heuristic — approximate family colour', heuristic, '\x1b[33m');

console.log('');
