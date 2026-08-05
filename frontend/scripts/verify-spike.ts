/**
 * Headless run of the Phase 0 render path.
 *
 * Everything the spike page does except the three.js draw: generate terrain,
 * write it as a real region file, read it back through the parser, resolve
 * appearances and scan for exposed blocks. Prints the numbers that decide how
 * Phase 2 has to be built.
 *
 *   npm run verify:spike                       synthetic world
 *   npm run verify:spike -- <file.mca>         a real region file
 *   npm run verify:spike -- <file.mca> 128     capped at 128 chunks
 */

import { readFile } from 'node:fs/promises';

import { unknownBlockNames } from '../src/world/anvil/blocks';
import { meshWorld } from '../src/world/mesh/faces';
import { writeRegion } from '../src/world/anvil/testkit/regionWrite';
import { synthesiseChunks } from '../src/world/anvil/testkit/syntheticWorld';
import { loadRegion, scanExposed, scanExposedPadded } from '../src/world/spike/scan';

const CHUNKS_ACROSS = 8;

const n = (v: number) => v.toLocaleString();
const pct = (a: number, b: number) => `${((a / Math.max(1, b)) * 100).toFixed(1)}%`;

function row(label: string, value: string, note = '') {
  console.log(`  ${label.padEnd(24)} ${value.padStart(14)}${note ? `   \x1b[2m${note}\x1b[0m` : ''}`);
}

function heading(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

const path = process.argv[2];

let bytes: Uint8Array;
let label: string;
let maxChunks: number;

if (path) {
  bytes = new Uint8Array(await readFile(path));
  label = path;
  maxChunks = Number(process.argv[3]) || 1024;
} else {
  const t = performance.now();
  const chunks = synthesiseChunks(CHUNKS_ACROSS);
  const genMs = performance.now() - t;

  const tw = performance.now();
  bytes = await writeRegion(chunks);
  const writeMs = performance.now() - tw;

  label = `synthetic ${CHUNKS_ACROSS}x${CHUNKS_ACROSS} chunks`;
  maxChunks = 1024;

  heading('Fixture generation');
  row('terrain', `${genMs.toFixed(0)} ms`, `${chunks.length} chunks`);
  row('region encode', `${writeMs.toFixed(0)} ms`, `${(bytes.length / 1024 / 1024).toFixed(2)} MB`);
}

/* ------------------------------------------------------------------- read */

heading(`Read: ${label}`);
const loaded = await loadRegion(bytes, maxChunks);

if (loaded.world.list.length === 0) {
  console.error(`\n\x1b[31mNo renderable chunks.\x1b[0m ${loaded.firstFailure}`);
  process.exit(1);
}

const sections = loaded.world.list.reduce((sum, c) => sum + c.sections.length, 0);
const paletteTotal = loaded.world.list.reduce(
  (sum, c) => sum + c.sections.reduce((s, x) => s + x.palette.length, 0),
  0
);
const uniform = loaded.world.list.reduce(
  (sum, c) => sum + c.sections.filter((s) => s.indices === null).length,
  0
);

row('chunks in region', n(loaded.chunksInRegion));
row('chunks loaded', n(loaded.world.list.length));
row('parse + inflate', `${loaded.parseMs.toFixed(0)} ms`, `${(loaded.parseMs / Math.max(1, loaded.world.list.length)).toFixed(2)} ms/chunk`);
row('sections', n(sections), `${uniform} uniform (no data array)`);
row('mean palette size', (paletteTotal / Math.max(1, sections)).toFixed(1));
if (loaded.skipped) row('skipped (not full)', n(loaded.skipped));
if (loaded.failed) row('failed', n(loaded.failed), loaded.firstFailure.slice(0, 60));

/* ------------------------------------------------------------------- scan */

heading('Exposure scan');
const scan = scanExposedPadded(loaded.world);

row('blocks scanned', n(scan.blocksScanned));
row('solid blocks', n(scan.solid), pct(scan.solid, scan.blocksScanned) + ' of scanned');
row('fully buried', n(scan.buried), pct(scan.buried, scan.solid) + ' of solid, culled');
row('exposed blocks', n(scan.blocks.length));

const rate = (r: typeof scan) => `${(((r.blocksScanned / r.ms) * 1000) / 1e6).toFixed(1)}M blocks/s`;
row('padded volume', `${scan.ms.toFixed(0)} ms`, rate(scan));
row('per chunk', `${(scan.ms / loaded.world.list.length).toFixed(2)} ms`, 'single-threaded');

/* The naive scan is ~7x slower, so cross-checking it against the shipped one
   is only affordable on a small area. Skip it on a big real world. */
if (loaded.world.list.length <= 200) {
  const naive = scanExposed(loaded.world);
  row('map lookups', `${naive.ms.toFixed(0)} ms`, `${rate(naive)} — reference`);

  const agrees =
    naive.blocks.length === scan.blocks.length &&
    naive.exposedFaces === scan.exposedFaces &&
    naive.buried === scan.buried;
  console.log(
    agrees
      ? '  \x1b[32mboth methods agree on every count\x1b[0m'
      : `  \x1b[31mMISMATCH\x1b[0m naive ${naive.blocks.length}/${naive.exposedFaces} vs padded ${scan.blocks.length}/${scan.exposedFaces}`
  );
  if (!agrees) process.exitCode = 1;
} else {
  console.log(`  \x1b[2mcross-check against the naive scan skipped above 200 chunks\x1b[0m`);
}

/* -------------------------------------------------------------- geometry */

heading('Face meshing');
const mesh = meshWorld(loaded.world);

row('faces emitted', n(mesh.faces), `${n(mesh.faces * 2)} triangles`);
row('mesh time', `${mesh.ms.toFixed(0)} ms`, `${(mesh.ms / loaded.world.list.length).toFixed(2)} ms/chunk`);
row('blocks visited', n(mesh.blocksScanned), `${pct(mesh.blocksScanned, scan.blocksScanned)} of a full scan`);

const vertexBytes =
  (mesh.opaque?.positions.byteLength ?? 0) +
  (mesh.opaque?.colors.byteLength ?? 0) +
  (mesh.translucent?.positions.byteLength ?? 0) +
  (mesh.translucent?.colors.byteLength ?? 0);
row(
  'vertex data',
  `${(vertexBytes / 1024 / 1024).toFixed(1)} MB`,
  `${(vertexBytes / Math.max(1, mesh.faces)).toFixed(0)} B/face`
);

/* The mesher must emit exactly the faces the reference scan counted. If these
   ever disagree, the mesher is dropping or duplicating geometry. */
const facesAgree = mesh.faces === scan.exposedFaces;
console.log(
  facesAgree
    ? `  \x1b[32mface count matches the reference scan exactly (${n(mesh.faces)})\x1b[0m`
    : `  \x1b[31mMISMATCH\x1b[0m mesher ${n(mesh.faces)} vs scan ${n(scan.exposedFaces)}`
);
if (!facesAgree) process.exitCode = 1;

heading('Geometry cost');
const naiveTris = scan.naiveFaces * 2;

row('naive cubes', n(scan.naiveFaces), `${n(naiveTris)} triangles`);
row('face-culled', n(mesh.faces), `${n(mesh.faces * 2)} triangles`);
row('culling saves', pct(scan.naiveFaces - mesh.faces, scan.naiveFaces), 'before any greedy merging');

const areaChunks = loaded.world.list.length;
const perChunkFaces = mesh.faces / Math.max(1, areaChunks);
const bytesPerChunk = vertexBytes / Math.max(1, areaChunks);
row('faces per chunk', n(Math.round(perChunkFaces)));

for (const chunks of [256, 1024, 4096]) {
  row(
    `projected at ${n(chunks)} chunks`,
    `${((perChunkFaces * chunks * 2) / 1e6).toFixed(1)}M tris`,
    `${((bytesPerChunk * chunks) / 1024 / 1024).toFixed(0)} MB of vertex data`
  );
}

/* -------------------------------------------------------------- coverage */

heading('Block coverage');
const unknown = unknownBlockNames();
if (unknown.length === 0) {
  console.log('  \x1b[32mevery block in this world has a colour\x1b[0m');
} else {
  row('unrecognised names', n(unknown.length), 'drawn magenta');
  for (const name of unknown.slice(0, 15)) console.log(`    \x1b[33m${name}\x1b[0m`);
  if (unknown.length > 15) console.log(`    \x1b[2m…and ${unknown.length - 15} more\x1b[0m`);
}

console.log('');
