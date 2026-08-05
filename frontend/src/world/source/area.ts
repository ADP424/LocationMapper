/**
 * Loading an area of a world, stitched across however many region files it
 * spans.
 *
 * Stitching is almost free: every chunk reports its own absolute `xPos`/`zPos`,
 * and a region boundary is only a fact about which file the bytes live in. The
 * work here is deciding *which* chunks to read, since a played world is far
 * larger than anything worth holding at once.
 *
 * Two-pass, so a large world costs a small read rather than a whole download:
 *   1. read only the 8 KiB header of the nearest regions to learn which chunks
 *      actually exist
 *   2. take the closest N of those and read just the region files holding them
 */

import { isRenderable, parseChunk, type ParsedChunk } from '../anvil/chunk';
import { AnvilError } from '../anvil/errors';
import { CHUNKS_PER_AXIS, listChunkSlots, RegionFile } from '../anvil/region';
import type { DimensionRef, RegionRef } from './worldSource';

/** Ceiling on header reads, so a world with thousands of regions stays cheap. */
const MAX_REGIONS_SCANNED = 48;

export interface AreaResult {
  chunks: ParsedChunk[];
  regionsScanned: number;
  regionsRead: number;
  /** Chunks the scanned headers say exist, before the budget is applied. */
  chunksAvailable: number;
  skipped: number;
  failed: number;
  firstFailure: string;
  headerMs: number;
  readMs: number;
  bytesRead: number;
  /** Bounds of what was loaded, in blocks. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

interface Candidate {
  cx: number;
  cz: number;
  lx: number;
  lz: number;
  region: RegionRef;
  distance: number;
}

/**
 * Squared chunk distance from a point to the *nearest* chunk a region could
 * hold — the region's bounding box clamped against the centre.
 *
 * Using the region's centre instead is subtly wrong: the four regions meeting
 * at the origin are all equidistant from it by centre, yet one of them contains
 * chunk (0,0). Ordering by centre makes that a tie broken arbitrarily, and the
 * region holding the closest chunk in the world can lose it.
 */
function regionMinChunkDistance(r: RegionRef, centerCX: number, centerCZ: number): number {
  const x0 = r.rx * CHUNKS_PER_AXIS;
  const z0 = r.rz * CHUNKS_PER_AXIS;
  const x1 = x0 + CHUNKS_PER_AXIS - 1;
  const z1 = z0 + CHUNKS_PER_AXIS - 1;
  const dx = centerCX < x0 ? x0 - centerCX : centerCX > x1 ? centerCX - x1 : 0;
  const dz = centerCZ < z0 ? z0 - centerCZ : centerCZ > z1 ? centerCZ - z1 : 0;
  return dx * dx + dz * dz;
}

/**
 * Load up to `maxChunks` chunks nearest a block position.
 *
 * `onProgress` is called between region reads; a large area is seconds of work
 * and silence reads as a hang.
 */
export async function loadArea(
  dimension: DimensionRef,
  centerBlockX: number,
  centerBlockZ: number,
  maxChunks: number,
  onProgress?: (message: string) => void
): Promise<AreaResult> {
  const centerCX = Math.floor(centerBlockX / 16);
  const centerCZ = Math.floor(centerBlockZ / 16);

  /* ------------------------------------------------- pass 1: headers */

  const tHeaders = performance.now();
  const ordered = [...dimension.regions].sort(
    (a, b) =>
      regionMinChunkDistance(a, centerCX, centerCZ) -
      regionMinChunkDistance(b, centerCX, centerCZ)
  );

  const candidates: Candidate[] = [];
  let regionsScanned = 0;
  /* Distance of the worst chunk we would currently keep. Only meaningful once
     the budget is full. */
  let worstKept = Infinity;

  for (const region of ordered) {
    if (regionsScanned >= MAX_REGIONS_SCANNED) break;

    /* Regions are ordered by their closest possible chunk, so once the budget
       is full we can stop as soon as a region cannot beat what we already have.
       Everything after it is at least as far away. */
    if (candidates.length >= maxChunks) {
      const byDistance = [...candidates].sort((a, b) => a.distance - b.distance);
      worstKept = byDistance[maxChunks - 1].distance;
      if (regionMinChunkDistance(region, centerCX, centerCZ) > worstKept) break;
    }

    regionsScanned++;
    onProgress?.(`scanning ${region.name} (${regionsScanned})`);

    let slots;
    try {
      slots = listChunkSlots(await region.header());
    } catch {
      continue; // a region too short to hold a header has nothing to offer
    }

    for (const slot of slots) {
      const cx = region.rx * CHUNKS_PER_AXIS + slot.lx;
      const cz = region.rz * CHUNKS_PER_AXIS + slot.lz;
      candidates.push({
        cx,
        cz,
        lx: slot.lx,
        lz: slot.lz,
        region,
        distance: (cx - centerCX) ** 2 + (cz - centerCZ) ** 2
      });
    }
  }

  const headerMs = performance.now() - tHeaders;
  const chunksAvailable = candidates.length;

  candidates.sort((a, b) => a.distance - b.distance);
  const wanted = candidates.slice(0, maxChunks);

  /* ------------------------------------------------- pass 2: chunk data */

  const byRegion = new Map<string, Candidate[]>();
  for (const c of wanted) {
    const list = byRegion.get(c.region.name) ?? [];
    list.push(c);
    byRegion.set(c.region.name, list);
  }

  const tRead = performance.now();
  const chunks: ParsedChunk[] = [];
  let skipped = 0;
  let failed = 0;
  let firstFailure = '';
  let bytesRead = 0;

  let done = 0;
  for (const [name, group] of byRegion) {
    onProgress?.(`reading ${name} (${++done}/${byRegion.size}, ${group.length} chunks)`);

    const ref = group[0].region;
    let region: RegionFile;
    try {
      const bytes = await ref.bytes();
      bytesRead += bytes.byteLength;
      region = new RegionFile(bytes, ref.rx, ref.rz);
    } catch (e) {
      failed += group.length;
      if (!firstFailure) firstFailure = e instanceof Error ? e.message : String(e);
      continue;
    }

    for (const c of group) {
      try {
        const nbt = await region.readChunk(c.lx, c.lz);
        if (!nbt) continue;
        const chunk = parseChunk(nbt);
        if (!isRenderable(chunk)) {
          skipped++;
          continue;
        }
        chunks.push(chunk);
      } catch (e) {
        failed++;
        if (!firstFailure) firstFailure = e instanceof AnvilError ? e.message : String(e);
      }
    }
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const c of chunks) {
    minX = Math.min(minX, c.cx * 16);
    maxX = Math.max(maxX, c.cx * 16 + 15);
    minZ = Math.min(minZ, c.cz * 16);
    maxZ = Math.max(maxZ, c.cz * 16 + 15);
  }

  return {
    chunks,
    regionsScanned,
    regionsRead: byRegion.size,
    chunksAvailable,
    skipped,
    failed,
    firstFailure,
    headerMs,
    readMs: performance.now() - tRead,
    bytesRead,
    minX,
    maxX,
    minZ,
    maxZ
  };
}
