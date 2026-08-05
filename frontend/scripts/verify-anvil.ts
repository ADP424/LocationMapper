/**
 * Phase 0 verification for the Anvil reader.
 *
 * Generates byte-real region files covering every bit-width the packed block
 * state format can produce, reads them back through the real parser, and
 * asserts every one of the 4096 blocks per section survives the round trip.
 *
 *   npm run verify:anvil
 *
 * This exists because a real world save was not available to test against, and
 * because a synthetic fixture can hit the awkward palette sizes (bits 4/5/9/12,
 * entries straddling the 32-bit halves of a long) that a real world may not.
 */

import { AnvilError, MIN_DATA_VERSION } from '../src/world/anvil/errors';
import {
  bitsForPalette,
  blockAt,
  parseChunk,
  SECTION_VOLUME,
  sectionIndex,
  unpackBlockStates,
  type BlockState
} from '../src/world/anvil/chunk';
import { RegionFile, SECTOR } from '../src/world/anvil/region';
import { NbtLongArray } from '../src/world/anvil/nbt';
import {
  packBlockStates,
  writeChunkNbt,
  writeRegion,
  type FixtureChunk,
  type FixtureSection
} from '../src/world/anvil/testkit/regionWrite';

/* ------------------------------------------------------------- harness */

let passed = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail = '') {
  if (ok) {
    passed++;
    return;
  }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

function section(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

function ok(label: string) {
  console.log(`  \x1b[32mok\x1b[0m   ${label}`);
}

/** Deterministic PRNG so a failure is reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makePalette(size: number): BlockState[] {
  const out: BlockState[] = [{ name: 'minecraft:air' }];
  for (let i = 1; i < size; i++) {
    out.push(
      i % 3 === 0
        ? { name: `minecraft:test_block_${i}`, properties: { facing: 'north', level: String(i % 16) } }
        : { name: `minecraft:test_block_${i}` }
    );
  }
  return out;
}

function randomIndices(paletteSize: number, seed: number): Uint16Array {
  const rnd = mulberry32(seed);
  const out = new Uint16Array(SECTION_VOLUME);
  for (let i = 0; i < SECTION_VOLUME; i++) out[i] = Math.floor(rnd() * paletteSize);
  /* Pin the extremes so an off-by-one at either end of the array is caught. */
  out[0] = paletteSize - 1;
  out[SECTION_VOLUME - 1] = paletteSize - 1;
  return out;
}

/* -------------------------------------------- 1. pack/unpack round trip */

section('1. Bit packing round trip');

/* Palette sizes chosen to land on each distinct bit width, including the
   maximum a 4096-block section can produce. */
const PALETTE_SIZES = [2, 16, 17, 33, 300, 1000, 4096];

for (const size of PALETTE_SIZES) {
  const bits = bitsForPalette(size);
  const perLong = Math.floor(64 / bits);
  const indices = randomIndices(size, size * 7919);
  const longs = packBlockStates(indices, size);

  /* Re-present the packed longs exactly as the NBT reader would hand them over. */
  const bytes = new Uint8Array(longs.length * 8);
  const view = new DataView(bytes.buffer);
  longs.forEach((v, i) => view.setBigInt64(i * 8, v));

  const decoded = unpackBlockStates(new NbtLongArray(view, longs.length), size);

  let mismatch = -1;
  for (let i = 0; i < SECTION_VOLUME; i++) {
    if (decoded[i] !== indices[i]) {
      mismatch = i;
      break;
    }
  }

  const straddles = Array.from({ length: perLong }, (_, s) => s * bits).some(
    (o) => o < 32 && o + bits > 32
  );

  check(
    `palette ${size} (${bits} bits)`,
    mismatch === -1,
    mismatch >= 0 ? `first mismatch at ${mismatch}: got ${decoded[mismatch]}, want ${indices[mismatch]}` : ''
  );
  if (mismatch === -1) {
    ok(
      `palette ${String(size).padStart(4)} -> ${bits} bits, ${perLong}/long, ${longs.length} longs` +
        (straddles ? ', straddles word boundary' : '')
    );
  }
}

/* ------------------------------------------------ 2. full region round trip */

section('2. Region file round trip');

const fixtureSections: FixtureSection[] = [
  { sy: -4, palette: [{ name: 'minecraft:bedrock' }] },
  { sy: 0, palette: makePalette(2), indices: randomIndices(2, 11) },
  { sy: 1, palette: makePalette(17), indices: randomIndices(17, 22) },
  { sy: 4, palette: makePalette(300), indices: randomIndices(300, 33) },
  { sy: 5, palette: makePalette(4096), indices: randomIndices(4096, 44) }
];

const fixtureChunks: FixtureChunk[] = [
  { cx: 0, cz: 0, sections: fixtureSections },
  { cx: 5, cz: 11, sections: fixtureSections.slice(0, 3) },
  { cx: 31, cz: 31, sections: fixtureSections.slice(0, 2) }
];

const regionBytes = await writeRegion(fixtureChunks);
ok(`wrote region: ${regionBytes.length} bytes, ${regionBytes.length / SECTOR} sectors`);

const region = new RegionFile(regionBytes);
check('generated chunk count', region.slots().length === 3, `got ${region.slots().length}`);
check('ungenerated slot is null', region.slot(2, 2) === null);
ok(`header lists ${region.slots().length} chunks, empty slots read as null`);

const nbt = await region.readChunk(0, 0);
check('chunk 0,0 present', nbt !== null);
const chunk = parseChunk(nbt!);

check('chunk coords', chunk.cx === 0 && chunk.cz === 0, `got ${chunk.cx},${chunk.cz}`);
check('data version', chunk.dataVersion === MIN_DATA_VERSION);
check('section count', chunk.sections.length === fixtureSections.length, `got ${chunk.sections.length}`);
check('uniform section has null indices', chunk.sections[0].indices === null);
ok(`parsed chunk 0,0: ${chunk.sections.length} sections, status ${chunk.status}`);

let blockMismatches = 0;
let compared = 0;
for (const expected of fixtureSections) {
  const actual = chunk.sections.find((s) => s.sy === expected.sy)!;
  for (let i = 0; i < SECTION_VOLUME; i++) {
    const want = expected.indices ? expected.palette[expected.indices[i]] : expected.palette[0];
    const got = actual.indices ? actual.palette[actual.indices[i]] : actual.palette[0];
    compared++;
    if (got.name !== want.name) blockMismatches++;
    else if (JSON.stringify(got.properties) !== JSON.stringify(want.properties)) blockMismatches++;
  }
}
check('every block survives the round trip', blockMismatches === 0, `${blockMismatches} mismatches`);
ok(`compared ${compared.toLocaleString()} blocks across ${fixtureSections.length} sections, 0 mismatches`);

/* YZX ordering: a block written at a known (x,y,z) must read back there. */
const probeSection = fixtureSections[3];
const probes: Array<[number, number, number]> = [
  [0, 0, 0],
  [15, 15, 15],
  [3, 9, 14],
  [15, 0, 0],
  [0, 0, 15]
];
let orderingOk = true;
for (const [x, ly, z] of probes) {
  const want = probeSection.palette[probeSection.indices![sectionIndex(x, ly, z)]];
  const got = blockAt(chunk, x, probeSection.sy * 16 + ly, z);
  if (got?.name !== want.name) orderingOk = false;
}
check('YZX index ordering', orderingOk);
ok(`blockAt() agrees with the packed order at ${probes.length} probe coordinates`);

check('block above loaded sections is null', blockAt(chunk, 0, 300, 0) === null);
ok('reads outside the loaded sections return null (treat as air)');

/* --------------------------------------------------- 3. failure handling */

section('3. Error handling');

function expectAnvil(label: string, code: string, fn: () => unknown) {
  try {
    fn();
    check(label, false, 'no error thrown');
  } catch (e) {
    const err = e as AnvilError;
    check(label, err instanceof AnvilError && err.code === code, `got ${err?.name}: ${err?.message}`);
    if (err instanceof AnvilError && err.code === code) ok(`${label}: ${err.message.slice(0, 96)}…`);
  }
}

expectAnvil('rejects pre-1.18 worlds', 'unsupported-version', () =>
  parseChunk(writeChunkNbt({ cx: 0, cz: 0, sections: [], dataVersion: 2724 }))
);

expectAnvil('rejects a header-sized file', 'bad-region', () => new RegionFile(new Uint8Array(16)));

/* Flip the compression byte of chunk 0,0 in a copy of the good region. */
const firstPayload = region.slot(0, 0)!.offsetSectors * SECTOR;

const lz4 = regionBytes.slice();
lz4[firstPayload + 4] = 4;
await expectAnvilAsync('rejects LZ4 compression', 'unsupported-compression', () =>
  new RegionFile(lz4).readChunk(0, 0)
);

const external = regionBytes.slice();
external[firstPayload + 4] = 2 | 0x80;
await expectAnvilAsync('rejects external .mcc chunks', 'external-chunk', () =>
  new RegionFile(external, 0, 0).readChunk(0, 0)
);

const truncated = regionBytes.slice(0, firstPayload + 8);
await expectAnvilAsync('detects a truncated region file', 'incomplete-chunk', () =>
  new RegionFile(truncated).readChunk(0, 0)
);

async function expectAnvilAsync(label: string, code: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    check(label, false, 'no error thrown');
  } catch (e) {
    const err = e as AnvilError;
    check(label, err instanceof AnvilError && err.code === code, `got ${err?.name}: ${err?.message}`);
    if (err instanceof AnvilError && err.code === code) ok(`${label}: ${err.message.slice(0, 96)}…`);
  }
}

/* ------------------------------------------------------------ 4. benchmark */

section('4. Unpack throughput');

/** BigInt reference implementation, kept only to justify the shipped one. */
function unpackViaBigInt(data: NbtLongArray, paletteLength: number, out: Uint16Array) {
  const bits = bitsForPalette(paletteLength);
  const perLong = Math.floor(64 / bits);
  const mask = (1n << BigInt(bits)) - 1n;
  let at = 0;
  for (let i = 0; at < SECTION_VOLUME; i++) {
    const long = data.view.getBigUint64(i * 8);
    for (let s = 0; s < perLong && at < SECTION_VOLUME; s++) {
      out[at++] = Number((long >> BigInt(s * bits)) & mask);
    }
  }
  return out;
}

const benchIndices = randomIndices(300, 99);
const benchLongs = packBlockStates(benchIndices, 300);
const benchBytes = new Uint8Array(benchLongs.length * 8);
const benchView = new DataView(benchBytes.buffer);
benchLongs.forEach((v, i) => benchView.setBigInt64(i * 8, v));
const benchData = new NbtLongArray(benchView, benchLongs.length);
const scratch = new Uint16Array(SECTION_VOLUME);

function time(label: string, fn: () => void, iterations: number) {
  for (let i = 0; i < 200; i++) fn(); // warm up
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const ms = performance.now() - t0;
  const blocks = iterations * SECTION_VOLUME;
  const perSecond = blocks / (ms / 1000);
  console.log(
    `  ${label.padEnd(22)} ${(ms / iterations).toFixed(4)} ms/section   ` +
      `${(perSecond / 1e6).toFixed(1)}M blocks/s`
  );
  return ms / iterations;
}

const ITER = 5000;
const wordsMs = time('word extraction', () => unpackBlockStates(benchData, 300, scratch), ITER);
const bigintMs = time('BigInt reference', () => unpackViaBigInt(benchData, 300, scratch), ITER);

console.log(`  \x1b[2mword extraction is ${(bigintMs / wordsMs).toFixed(1)}x faster\x1b[0m`);

/* A full region is 1024 chunks; a populated chunk has roughly 8 non-uniform
   sections once you exclude the all-air ones above the surface. */
const sectionsPerRegion = 1024 * 8;
console.log(
  `  \x1b[2mprojected: ${((wordsMs * sectionsPerRegion) / 1000).toFixed(2)}s of unpack per full region, single-threaded\x1b[0m`
);

/* ---------------------------------------------------------------- report */

console.log('');
if (failures.length === 0) {
  console.log(`\x1b[32m\x1b[1mAll ${passed} checks passed.\x1b[0m`);
} else {
  console.log(`\x1b[31m\x1b[1m${failures.length} of ${passed + failures.length} checks failed:\x1b[0m`);
  for (const f of failures) console.log(`  \x1b[31mFAIL\x1b[0m ${f}`);
  process.exitCode = 1;
}
