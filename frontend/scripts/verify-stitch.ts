/**
 * Verify that an area assembled from several region files is one continuous
 * world.
 *
 * Region boundaries are where this goes wrong: a sign error on `rx * 32 + lx`
 * produces a world that still loads, still renders, and is quietly shredded
 * into misplaced 512-block tiles. So the test spans four regions meeting at the
 * origin, including negative coordinates, and checks the terrain that comes
 * back against the generator that produced it.
 *
 *   npm run verify:stitch
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { blockAt } from '../src/world/anvil/chunk';
import {
  synthesiseChunk,
  heightAt
} from '../src/world/anvil/testkit/syntheticWorld';
import { writeRegion, type FixtureChunk } from '../src/world/anvil/testkit/regionWrite';
import { loadArea } from '../src/world/source/area';
import type { DimensionRef, RegionRef } from '../src/world/source/worldSource';

let passed = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail = '') {
  if (ok) {
    passed++;
    console.log(`  \x1b[32mok\x1b[0m   ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function heading(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

const n = (v: number) => v.toLocaleString();

/* ------------------------------------------------------------- build world */

heading('Building a four-region world around the origin');

/** Chunks per region, taken from the corner nearest the origin. */
const BAND = 6;

/* The four regions meeting at (0,0). Negative region coordinates are the whole
   point: `-1 * 32 + 31` must land on chunk -1, not 31. */
const REGIONS: Array<[number, number]> = [
  [-1, -1],
  [0, -1],
  [-1, 0],
  [0, 0]
];

const dir = await mkdtemp(join(tmpdir(), 'anvil-stitch-'));
const refs: RegionRef[] = [];
let generated = 0;

for (const [rx, rz] of REGIONS) {
  const chunks: FixtureChunk[] = [];
  /* Take the BAND x BAND corner closest to the origin in each region. */
  const startX = rx < 0 ? -BAND : 0;
  const startZ = rz < 0 ? -BAND : 0;

  for (let dz = 0; dz < BAND; dz++) {
    for (let dx = 0; dx < BAND; dx++) {
      chunks.push(synthesiseChunk(startX + dx, startZ + dz));
    }
  }
  generated += chunks.length;

  const name = `r.${rx}.${rz}.mca`;
  const path = join(dir, name);
  await writeFile(path, await writeRegion(chunks));

  const size = (await readFile(path)).byteLength;
  refs.push({
    rx,
    rz,
    name,
    size,
    header: async () => new Uint8Array((await readFile(path)).subarray(0, 8192)),
    bytes: async () => new Uint8Array(await readFile(path))
  });
}

console.log(`  wrote ${REGIONS.length} region files, ${generated} chunks, into ${dir}`);

const dimension: DimensionRef = {
  id: 'minecraft:overworld',
  label: 'Overworld',
  path: 'region',
  regions: refs
};

/* ------------------------------------------------------------------ load */

heading('Loading an area centred on the origin');

const BUDGET = 100;
const area = await loadArea(dimension, 0, 0, BUDGET);

console.log(
  `  scanned ${area.regionsScanned} regions, read ${area.regionsRead}, ` +
    `${n(area.chunksAvailable)} chunks available, ${n(area.chunks.length)} loaded ` +
    `(${area.headerMs.toFixed(0)} ms headers, ${area.readMs.toFixed(0)} ms read)`
);

check('all four regions were read', area.regionsRead === 4, `read ${area.regionsRead}`);
check('every generated chunk was visible to the header scan', area.chunksAvailable === generated, `saw ${area.chunksAvailable}`);
check('honoured the chunk budget', area.chunks.length === BUDGET, `loaded ${area.chunks.length}`);
check('no chunk failed to parse', area.failed === 0, `${area.failed} failed: ${area.firstFailure}`);

/* ------------------------------------------------------------ uniqueness */

heading('Chunk placement');

const seen = new Set<string>();
let duplicates = 0;
for (const c of area.chunks) {
  const key = `${c.cx},${c.cz}`;
  if (seen.has(key)) duplicates++;
  seen.add(key);
}
check('no chunk loaded twice', duplicates === 0, `${duplicates} duplicates`);

/* Chunks must come from all four quadrants, or the negative-coordinate maths
   is wrong in a way a single-quadrant test would never notice. */
const quadrants = new Set(area.chunks.map((c) => `${c.cx < 0 ? '-' : '+'}${c.cz < 0 ? '-' : '+'}`));
check('chunks span all four quadrants', quadrants.size === 4, `got ${[...quadrants].join(' ')}`);

/* Nearest-first: nothing left out may be closer than something taken. */
const loadedMax = Math.max(...area.chunks.map((c) => c.cx ** 2 + c.cz ** 2));
const allCoords: Array<[number, number]> = [];
for (const [rx, rz] of REGIONS) {
  const startX = rx < 0 ? -BAND : 0;
  const startZ = rz < 0 ? -BAND : 0;
  for (let dz = 0; dz < BAND; dz++) {
    for (let dx = 0; dx < BAND; dx++) allCoords.push([startX + dx, startZ + dz]);
  }
}
const omittedMin = Math.min(
  ...allCoords
    .filter(([cx, cz]) => !seen.has(`${cx},${cz}`))
    .map(([cx, cz]) => cx ** 2 + cz ** 2)
);
check('loaded the nearest chunks first', loadedMax <= omittedMin, `kept ${loadedMax}, dropped ${omittedMin}`);

/* --------------------------------------------------------- terrain match */

heading('Terrain continuity across region seams');

const byKey = new Map(area.chunks.map((c) => [`${c.cx},${c.cz}`, c]));

/* Water sits above the terrain it covers, and the generator plants trees on
   top of it — neither is ground, so both are skipped when measuring height. */
const NOT_GROUND = new Set([
  'minecraft:air',
  'minecraft:water',
  'minecraft:oak_log',
  'minecraft:oak_leaves'
]);

/** Highest terrain block in a column, read back out of the loaded chunks. */
function surfaceAt(x: number, z: number): number | null {
  const chunk = byKey.get(`${x >> 4},${z >> 4}`);
  if (!chunk) return null;
  for (let y = 200; y >= -64; y--) {
    const block = blockAt(chunk, x & 15, y, z & 15);
    if (block && !NOT_GROUND.has(block.name)) return y;
  }
  return null;
}

/* Walk a line straight through x = 0, the seam between region -1 and region 0,
   and compare every column against the generator. */
let compared = 0;
let mismatches = 0;
let firstMismatch = '';

for (let z = -40; z <= 40; z++) {
  for (let x = -40; x <= 40; x++) {
    const got = surfaceAt(x, z);
    if (got === null) continue;
    compared++;
    const want = heightAt(x, z);
    if (got !== want) {
      mismatches++;
      if (!firstMismatch) firstMismatch = `at (${x}, ${z}): surface y=${got}, generator says ${want}`;
    }
  }
}

check(
  `surface height matches the generator across ${n(compared)} columns`,
  mismatches === 0 && compared > 2000,
  mismatches ? `${mismatches} mismatches, first ${firstMismatch}` : `only ${compared} columns compared`
);

/* A misaligned region shows up as a cliff exactly on a 512-block boundary. */
let maxSeamStep = 0;
let seamSamples = 0;
for (let z = -40; z <= 40; z++) {
  const left = surfaceAt(-1, z);
  const right = surfaceAt(0, z);
  if (left === null || right === null) continue;
  seamSamples++;
  maxSeamStep = Math.max(maxSeamStep, Math.abs(left - right));
}
check(
  `no cliff at the x=0 region seam (${seamSamples} samples, max step ${maxSeamStep})`,
  seamSamples > 40 && maxSeamStep <= 4,
  `max step ${maxSeamStep} over ${seamSamples} samples`
);

let maxSeamStepZ = 0;
let seamSamplesZ = 0;
for (let x = -40; x <= 40; x++) {
  const back = surfaceAt(x, -1);
  const front = surfaceAt(x, 0);
  if (back === null || front === null) continue;
  seamSamplesZ++;
  maxSeamStepZ = Math.max(maxSeamStepZ, Math.abs(back - front));
}
check(
  `no cliff at the z=0 region seam (${seamSamplesZ} samples, max step ${maxSeamStepZ})`,
  seamSamplesZ > 40 && maxSeamStepZ <= 4,
  `max step ${maxSeamStepZ} over ${seamSamplesZ} samples`
);

/* ---------------------------------------------------------------- report */

console.log('');
if (failures.length === 0) {
  console.log(`\x1b[32m\x1b[1mAll ${passed} checks passed.\x1b[0m`);
} else {
  console.log(`\x1b[31m\x1b[1m${failures.length} of ${passed + failures.length} checks failed.\x1b[0m`);
  process.exitCode = 1;
}
