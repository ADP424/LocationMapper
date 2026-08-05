/**
 * The renderer-agnostic half of the Phase 0 spike.
 *
 * Everything here is pure data: load chunks, resolve appearances, and decide
 * which blocks are exposed. Kept free of three.js so the same code can run
 * headlessly under tsx and produce the numbers that size the Phase 2 mesher.
 */

import { appearanceOf, type BlockAppearance } from '../anvil/blocks';
import { isRenderable, parseChunk, sectionIndex, type ParsedChunk } from '../anvil/chunk';
import { AnvilError } from '../anvil/errors';
import { RegionFile } from '../anvil/region';

export const AIR: BlockAppearance = { solid: false, opaque: false, color: 0, alpha: 0 };

/** Random access across a set of loaded chunks, including over chunk seams. */
export class World {
  private readonly chunks = new Map<string, ParsedChunk>();
  /** Palette resolved to appearances once per section, not per block. */
  private readonly appearances = new Map<string, Map<number, BlockAppearance[]>>();

  minX = Infinity;
  maxX = -Infinity;
  minZ = Infinity;
  maxZ = -Infinity;

  add(chunk: ParsedChunk) {
    const key = `${chunk.cx},${chunk.cz}`;
    this.chunks.set(key, chunk);

    const bySection = new Map<number, BlockAppearance[]>();
    for (const s of chunk.sections) {
      bySection.set(
        s.sy,
        s.palette.map((b) => appearanceOf(b.name))
      );
    }
    this.appearances.set(key, bySection);

    this.minX = Math.min(this.minX, chunk.cx * 16);
    this.maxX = Math.max(this.maxX, chunk.cx * 16 + 15);
    this.minZ = Math.min(this.minZ, chunk.cz * 16);
    this.maxZ = Math.max(this.maxZ, chunk.cz * 16 + 15);
  }

  get list(): ParsedChunk[] {
    return [...this.chunks.values()];
  }

  palettesFor(chunk: ParsedChunk, sy: number): BlockAppearance[] {
    return this.appearances.get(`${chunk.cx},${chunk.cz}`)!.get(sy)!;
  }

  /** Appearance at world coordinates; air outside anything loaded. */
  at(wx: number, wy: number, wz: number): BlockAppearance {
    const chunk = this.chunks.get(`${wx >> 4},${wz >> 4}`);
    if (!chunk) return AIR;

    const sy = wy >> 4;
    const section = chunk.sections.find((s) => s.sy === sy);
    if (!section) return AIR;

    const palette = this.appearances.get(`${chunk.cx},${chunk.cz}`)!.get(sy)!;
    const index = section.indices ? section.indices[sectionIndex(wx & 15, wy & 15, wz & 15)] : 0;
    return palette[index] ?? AIR;
  }
}

export interface LoadResult {
  world: World;
  chunksInRegion: number;
  skipped: number;
  failed: number;
  firstFailure: string;
  parseMs: number;
}

/**
 * Read chunks out of a region, preferring those nearest the middle of the
 * populated area so a capped load shows contiguous terrain rather than a
 * scattered edge.
 */
export async function loadRegion(
  regionBytes: Uint8Array,
  maxChunks: number
): Promise<LoadResult> {
  const t0 = performance.now();
  const region = new RegionFile(regionBytes);
  const slots = region.slots();

  const mid = slots.reduce(
    (acc, s) => ({ x: acc.x + s.lx / slots.length, z: acc.z + s.lz / slots.length }),
    { x: 0, z: 0 }
  );
  const ordered = [...slots].sort(
    (a, b) =>
      (a.lx - mid.x) ** 2 + (a.lz - mid.z) ** 2 - ((b.lx - mid.x) ** 2 + (b.lz - mid.z) ** 2)
  );

  const world = new World();
  let skipped = 0;
  let failed = 0;
  let firstFailure = '';

  for (const slot of ordered.slice(0, maxChunks)) {
    try {
      const nbt = await region.readChunk(slot.lx, slot.lz);
      if (!nbt) continue;
      const chunk = parseChunk(nbt);
      if (!isRenderable(chunk)) {
        skipped++;
        continue;
      }
      world.add(chunk);
    } catch (e) {
      failed++;
      if (!firstFailure) firstFailure = e instanceof AnvilError ? e.message : String(e);
    }
  }

  return {
    world,
    chunksInRegion: slots.length,
    skipped,
    failed,
    firstFailure,
    parseMs: performance.now() - t0
  };
}

export interface ExposedBlock {
  x: number;
  y: number;
  z: number;
  color: number;
  opaque: boolean;
}

export interface ScanResult {
  blocks: ExposedBlock[];
  blocksScanned: number;
  solid: number;
  buried: number;
  /** Faces the naive approach submits: a whole cube per exposed block. */
  naiveFaces: number;
  /** Faces that actually face open space — the ceiling a face-culled mesher
   *  hits before any greedy merging. The gap between the two is the win. */
  exposedFaces: number;
  ms: number;
}

/**
 * Every solid block with at least one exposed face.
 *
 * This is the only culling the spike does. A block fully enclosed by opaque
 * neighbours contributes nothing; everything else becomes a whole cube, which
 * is exactly the waste greedy meshing exists to remove.
 */
export function scanExposed(world: World): ScanResult {
  const t0 = performance.now();
  const blocks: ExposedBlock[] = [];
  let blocksScanned = 0;
  let solid = 0;
  let buried = 0;
  let exposedFaces = 0;

  for (const chunk of world.list) {
    for (const section of chunk.sections) {
      const palette = world.palettesFor(chunk, section.sy);
      /* A uniform section of air is the common case — skip it whole. */
      if (!section.indices && !palette[0].solid) continue;

      const baseY = section.sy * 16;
      for (let ly = 0; ly < 16; ly++) {
        for (let lz = 0; lz < 16; lz++) {
          for (let lx = 0; lx < 16; lx++) {
            blocksScanned++;
            const a = section.indices ? palette[section.indices[sectionIndex(lx, ly, lz)]] : palette[0];
            if (!a || !a.solid) continue;
            solid++;

            const x = chunk.cx * 16 + lx;
            const y = baseY + ly;
            const z = chunk.cz * 16 + lz;

            const open =
              (world.at(x + 1, y, z).opaque ? 0 : 1) +
              (world.at(x - 1, y, z).opaque ? 0 : 1) +
              (world.at(x, y + 1, z).opaque ? 0 : 1) +
              (world.at(x, y - 1, z).opaque ? 0 : 1) +
              (world.at(x, y, z + 1).opaque ? 0 : 1) +
              (world.at(x, y, z - 1).opaque ? 0 : 1);

            if (open === 0) {
              buried++;
              continue;
            }

            exposedFaces += open;
            blocks.push({ x, y, z, color: a.color, opaque: a.opaque });
          }
        }
      }
    }
  }

  return {
    blocks,
    blocksScanned,
    solid,
    buried,
    naiveFaces: blocks.length * 6,
    exposedFaces,
    ms: performance.now() - t0
  };
}

/* ------------------------------------------------------- padded volumes */

/**
 * Appearances interned to small integers so a volume can be a flat typed array.
 *
 * `appearanceOf` memoises, so the same block name always yields the same object
 * reference and identity is a valid key.
 */
class Appearances {
  private readonly ids = new Map<BlockAppearance, number>();
  readonly solid: number[] = [];
  readonly opaque: number[] = [];
  readonly color: number[] = [];

  constructor() {
    this.idOf(AIR);
  }

  idOf(a: BlockAppearance): number {
    let id = this.ids.get(a);
    if (id === undefined) {
      id = this.solid.length;
      this.ids.set(a, id);
      this.solid.push(a.solid ? 1 : 0);
      this.opaque.push(a.opaque ? 1 : 0);
      this.color.push(a.color);
    }
    return id;
  }
}

/**
 * The same scan, but over a flat 18-wide padded volume per chunk instead of
 * random access through the chunk map.
 *
 * This is how the Phase 2 mesher has to work. The naive version above spends
 * all its time building `${cx},${cz}` strings and running `sections.find()` six
 * times per block; here the interior is filled once by a linear walk and the
 * neighbour test is three integer offsets. The border plane is the only part
 * that still pays for cross-chunk lookups, and it is the surface of the box
 * rather than its volume.
 */
export function scanExposedPadded(world: World): ScanResult {
  const t0 = performance.now();
  const table = new Appearances();
  const blocks: ExposedBlock[] = [];

  let blocksScanned = 0;
  let solid = 0;
  let buried = 0;
  let exposedFaces = 0;

  const SX = 1;
  const SZ = 18;

  for (const chunk of world.list) {
    if (chunk.sections.length === 0) continue;

    const minSy = chunk.sections[0].sy;
    const maxSy = chunk.sections[chunk.sections.length - 1].sy;
    const yLo = minSy * 16 - 1;
    const yHi = maxSy * 16 + 16;
    const height = yHi - yLo + 1;
    const SY = SZ * 18;

    const volume = new Uint16Array(18 * 18 * height);
    const index = (x: number, y: number, z: number) =>
      (y - yLo) * SY + (z + 1) * SZ + (x + 1) * SX;

    /* Interior: one linear pass per section, no lookups at all. */
    for (const section of chunk.sections) {
      const palette = world.palettesFor(chunk, section.sy).map((a) => table.idOf(a));
      if (!section.indices) {
        if (palette[0] === 0) continue;
        const base = section.sy * 16;
        for (let ly = 0; ly < 16; ly++) {
          for (let lz = 0; lz < 16; lz++) {
            for (let lx = 0; lx < 16; lx++) volume[index(lx, base + ly, lz)] = palette[0];
          }
        }
        continue;
      }
      const base = section.sy * 16;
      for (let ly = 0; ly < 16; ly++) {
        for (let lz = 0; lz < 16; lz++) {
          for (let lx = 0; lx < 16; lx++) {
            volume[index(lx, base + ly, lz)] = palette[section.indices[sectionIndex(lx, ly, lz)]];
          }
        }
      }
    }

    /* Border: the surface of the box, filled from neighbouring chunks so faces
       at a chunk seam are culled correctly instead of showing as a wall. */
    const ox = chunk.cx * 16;
    const oz = chunk.cz * 16;
    for (let y = yLo; y <= yHi; y++) {
      const edge = y === yLo || y === yHi;
      for (let z = -1; z <= 16; z++) {
        for (let x = -1; x <= 16; x++) {
          if (!edge && x !== -1 && x !== 16 && z !== -1 && z !== 16) continue;
          volume[index(x, y, z)] = table.idOf(world.at(ox + x, y, oz + z));
        }
      }
    }

    const { solid: isSolid, opaque: isOpaque, color: colorOf } = table;

    for (let y = yLo + 1; y < yHi; y++) {
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          blocksScanned++;
          const at = index(x, y, z);
          const id = volume[at];
          if (id === 0 || !isSolid[id]) continue;
          solid++;

          const open =
            (isOpaque[volume[at + SX]] ? 0 : 1) +
            (isOpaque[volume[at - SX]] ? 0 : 1) +
            (isOpaque[volume[at + SY]] ? 0 : 1) +
            (isOpaque[volume[at - SY]] ? 0 : 1) +
            (isOpaque[volume[at + SZ]] ? 0 : 1) +
            (isOpaque[volume[at - SZ]] ? 0 : 1);

          if (open === 0) {
            buried++;
            continue;
          }

          exposedFaces += open;
          blocks.push({
            x: ox + x,
            y,
            z: oz + z,
            color: colorOf[id],
            opaque: isOpaque[id] === 1
          });
        }
      }
    }
  }

  return {
    blocks,
    blocksScanned,
    solid,
    buried,
    naiveFaces: blocks.length * 6,
    exposedFaces,
    ms: performance.now() - t0
  };
}
