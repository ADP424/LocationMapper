/**
 * The invariant streaming rests on: meshing chunk by chunk must produce exactly
 * the geometry that meshing the whole area at once produces.
 *
 * Streaming builds one mesh per chunk so tiles can be added and dropped
 * independently. That is only valid if a chunk meshed alone — with its
 * neighbours visible in the store for seam culling, but not itself in the mesh
 * pass — emits the same faces it would as part of a bulk mesh. If it does not,
 * the difference shows up as walls along chunk seams, which is exactly the
 * artefact that is hardest to spot and hardest to attribute.
 *
 * Also checks the rule the streamer uses to decide when a chunk may be meshed:
 * only its four side neighbours are ever sampled, never the corners.
 *
 *   npm run verify:stream                     synthetic world
 *   npm run verify:stream -- <file.mca>       a real region file
 */

import { readFile } from 'node:fs/promises';

import { writeRegion } from '../src/world/anvil/testkit/regionWrite';
import { synthesiseChunks } from '../src/world/anvil/testkit/syntheticWorld';
import { meshWorld } from '../src/world/mesh/faces';
import { loadRegion } from '../src/world/spike/scan';
import { ChunkStore } from '../src/world/stream/chunkStore';

const CHUNKS_ACROSS = 8;

const n = (v: number) => v.toLocaleString();

function row(label: string, value: string, note = '') {
  console.log(`  ${label.padEnd(26)} ${value.padStart(12)}${note ? `   \x1b[2m${note}\x1b[0m` : ''}`);
}

const path = process.argv[2];
const bytes = path
  ? new Uint8Array(await readFile(path))
  : await writeRegion(synthesiseChunks(CHUNKS_ACROSS));

const loaded = await loadRegion(bytes, Number(process.argv[3]) || 256);
if (loaded.world.list.length === 0) {
  console.error(`\n\x1b[31mNo renderable chunks.\x1b[0m ${loaded.firstFailure}`);
  process.exit(1);
}

console.log(`\n\x1b[1m${path ?? `synthetic ${CHUNKS_ACROSS}x${CHUNKS_ACROSS}`}\x1b[0m`);
row('chunks', n(loaded.world.list.length));

/* ------------------------------------------------------------- bulk mesh */

const bulk = meshWorld(loaded.world);
row('bulk mesh', `${n(bulk.faces)} faces`, `${bulk.ms.toFixed(0)} ms`);

/* -------------------------------------------------------- per-chunk mesh */

const store = new ChunkStore();
for (const chunk of loaded.world.list) store.add(chunk);

let perChunkFaces = 0;
let perChunkBytes = 0;
let tiles = 0;
const t0 = performance.now();

for (const chunk of loaded.world.list) {
  const result = meshWorld(store.sourceFor(chunk));
  perChunkFaces += result.faces;
  perChunkBytes +=
    (result.opaque?.positions.byteLength ?? 0) +
    (result.opaque?.colors.byteLength ?? 0) +
    (result.translucent?.positions.byteLength ?? 0) +
    (result.translucent?.colors.byteLength ?? 0);
  if (result.faces > 0) tiles++;
}

const perChunkMs = performance.now() - t0;
row('per-chunk mesh', `${n(perChunkFaces)} faces`, `${perChunkMs.toFixed(0)} ms, ${tiles} tiles`);
row('overhead', `${(perChunkMs / Math.max(1, bulk.ms)).toFixed(2)}x`, 'cost of independent tiles');
row('vertex data', `${(perChunkBytes / 1024 / 1024).toFixed(1)} MB`);

const agrees = perChunkFaces === bulk.faces;
console.log(
  agrees
    ? `  \x1b[32mper-chunk meshing is identical to bulk (${n(bulk.faces)} faces)\x1b[0m`
    : `  \x1b[31mMISMATCH\x1b[0m per-chunk ${n(perChunkFaces)} vs bulk ${n(bulk.faces)}`
);
if (!agrees) process.exitCode = 1;

/* ------------------------------------------------- the neighbour rule */

/**
 * The streamer meshes a chunk once its four side neighbours are resolved. If
 * the mesher ever sampled a diagonal, that rule would be wrong and seams would
 * appear at chunk corners — so prove the corners are never read by meshing with
 * them deliberately withheld.
 */
console.log(`\n\x1b[1mNeighbour rule\x1b[0m`);

const interior = loaded.world.list.filter(
  (c) =>
    store.has(c.cx + 1, c.cz) &&
    store.has(c.cx - 1, c.cz) &&
    store.has(c.cx, c.cz + 1) &&
    store.has(c.cx, c.cz - 1)
);

let sidesOnlyFaces = 0;
let fullFaces = 0;

for (const chunk of interior) {
  const sidesOnly = new ChunkStore();
  sidesOnly.add(chunk);
  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1]
  ]) {
    const neighbour = store.get(chunk.cx + dx, chunk.cz + dz);
    if (neighbour) sidesOnly.add(neighbour);
  }
  sidesOnlyFaces += meshWorld(sidesOnly.sourceFor(chunk)).faces;
  fullFaces += meshWorld(store.sourceFor(chunk)).faces;
}

row('chunks with 4 neighbours', n(interior.length));
row('sides only', n(sidesOnlyFaces));
row('all neighbours', n(fullFaces));

const cornersIgnored = sidesOnlyFaces === fullFaces;
console.log(
  cornersIgnored
    ? '  \x1b[32mdiagonal neighbours never affect a chunk mesh — the four-side rule is sound\x1b[0m'
    : '  \x1b[31mMISMATCH\x1b[0m corners do affect the mesh; the streamer must wait for 8 neighbours'
);
if (!cornersIgnored) process.exitCode = 1;

console.log('');
