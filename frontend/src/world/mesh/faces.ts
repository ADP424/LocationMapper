/**
 * Face meshing: one quad per exposed block face, merged into a few large
 * buffers.
 *
 * Replaces the spike's one-cube-per-block approach. A cube draws all six faces
 * whether or not anything can see them, and instancing costs a 64-byte matrix
 * per block. Emitting only the faces that touch open space cuts triangles by
 * about two thirds on real worlds, and dropping the per-instance matrix is what
 * actually raises the ceiling on how much world fits at once.
 *
 * Two decisions worth stating:
 *
 *   - Positions are Int16. Every face corner sits on an integer block boundary,
 *     so nothing is lost, and it halves the largest buffer.
 *   - Lighting is baked into vertex colours as a fixed per-face tint. No lights,
 *     no normals, no light propagation — a MeshBasicMaterial draws it. This is
 *     the "rendered, minus the fancy lights" look, and it means the whole mesh
 *     is position + colour and nothing else.
 */

import { appearanceOf, type BlockAppearance } from '../anvil/blocks';
import { sectionIndex, type ParsedChunk } from '../anvil/chunk';

/** Something with the block lookups the mesher needs. */
export interface BlockSource {
  list: ParsedChunk[];
  palettesFor(chunk: ParsedChunk, sy: number): BlockAppearance[];
  at(x: number, y: number, z: number): BlockAppearance;
}

/**
 * Fixed shading per face direction, standing in for real lighting.
 * Top brightest, bottom darkest, and the two horizontal axes differ so that
 * perpendicular walls do not merge into one flat silhouette.
 */
const FACE_TINT = [0.8, 0.8, 1.0, 0.45, 0.65, 0.65]; // +X -X +Y -Y +Z -Z

/**
 * Corners of each face, counter-clockwise seen from outside, in the same order
 * as FACE_TINT. Each entry is four corners of unit offsets from the block.
 */
const FACE_CORNERS: number[][][] = [
  /* +X */ [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]],
  /* -X */ [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
  /* +Y */ [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]],
  /* -Y */ [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
  /* +Z */ [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
  /* -Z */ [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]]
];

/* Neighbour offsets matching FACE_CORNERS order. */
const FACE_STEP = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1]
];

/* --------------------------------------------------------------- buffers */

const SINK_BLOCK = 1 << 18;

/** Append-only typed array that grows in fixed blocks. A single doubling
 *  reallocation of a 100 MB buffer is a stall worth avoiding. */
class Sink<T extends Int16Array | Uint8Array> {
  private readonly blocks: T[] = [];
  private current: T;
  private used = 0;

  constructor(private readonly make: (n: number) => T) {
    this.current = make(SINK_BLOCK);
  }

  push(a: number, b: number, c: number) {
    if (this.used + 3 > SINK_BLOCK) {
      this.blocks.push(this.current.subarray(0, this.used) as T);
      this.current = this.make(SINK_BLOCK);
      this.used = 0;
    }
    this.current[this.used++] = a;
    this.current[this.used++] = b;
    this.current[this.used++] = c;
  }

  finish(): T {
    const total = this.blocks.reduce((n, b) => n + b.length, 0) + this.used;
    const out = this.make(total);
    let at = 0;
    for (const b of this.blocks) {
      out.set(b, at);
      at += b.length;
    }
    out.set(this.current.subarray(0, this.used) as T, at);
    return out;
  }
}

export interface FaceBuffers {
  /** 6 vertices per face (two triangles), 3 components each. */
  positions: Int16Array;
  /** Matching vertex colours, 0-255 per channel. */
  colors: Uint8Array;
  faces: number;
}

export interface MeshResult {
  opaque: FaceBuffers | null;
  translucent: FaceBuffers | null;
  faces: number;
  blocksScanned: number;
  solid: number;
  ms: number;
}

class Builder {
  readonly positions = new Sink<Int16Array>((n) => new Int16Array(n));
  readonly colors = new Sink<Uint8Array>((n) => new Uint8Array(n));
  faces = 0;

  quad(x: number, y: number, z: number, face: number, color: number) {
    const corners = FACE_CORNERS[face];
    const tint = FACE_TINT[face];
    const r = Math.round(((color >> 16) & 0xff) * tint);
    const g = Math.round(((color >> 8) & 0xff) * tint);
    const b = Math.round((color & 0xff) * tint);

    /* Non-indexed: two triangles sharing corners 0 and 2. Indexed buffers save
       a third of the vertices but cost an index array, which nets out roughly
       even here and complicates the sink. */
    const order = [0, 1, 2, 0, 2, 3];
    for (const i of order) {
      const c = corners[i];
      this.positions.push(x + c[0], y + c[1], z + c[2]);
      this.colors.push(r, g, b);
    }
    this.faces++;
  }

  finish(): FaceBuffers | null {
    if (this.faces === 0) return null;
    return { positions: this.positions.finish(), colors: this.colors.finish(), faces: this.faces };
  }
}

/* --------------------------------------------------------------- meshing */

/** Appearances interned to integers so a volume can be a flat typed array. */
class Palette {
  private readonly ids = new Map<BlockAppearance, number>();
  readonly solid: Uint8Array;
  readonly opaque: Uint8Array;
  readonly color: Int32Array;
  private count = 0;

  constructor(capacity = 4096) {
    this.solid = new Uint8Array(capacity);
    this.opaque = new Uint8Array(capacity);
    this.color = new Int32Array(capacity);
    /* Id 0 is always air, so an untouched volume cell reads as empty. */
    this.idOf({ solid: false, opaque: false, color: 0, alpha: 0 });
  }

  idOf(a: BlockAppearance): number {
    let id = this.ids.get(a);
    if (id === undefined) {
      id = this.count++;
      this.ids.set(a, id);
      this.solid[id] = a.solid ? 1 : 0;
      this.opaque[id] = a.opaque ? 1 : 0;
      this.color[id] = a.color;
    }
    return id;
  }
}

/**
 * Mesh every chunk in the source.
 *
 * Per chunk it fills an 18-wide padded volume — the one-block border comes from
 * neighbouring chunks so faces at a seam are culled instead of showing as a
 * wall — then walks only the sections that actually contain something. That
 * last part matters: a played world is mostly air, and a chunk 24 sections tall
 * with three of them occupied should cost three sections of work, not 24.
 */
export function meshWorld(source: BlockSource): MeshResult {
  const t0 = performance.now();
  const table = new Palette();
  const opaqueOut = new Builder();
  const clearOut = new Builder();

  let blocksScanned = 0;
  let solid = 0;

  const SX = 1;
  const SZ = 18;

  for (const chunk of source.list) {
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

    /* Which sections hold anything worth drawing. A solid block is always in
       one of these, so the scan below never needs to look anywhere else. */
    const occupied: number[] = [];

    for (const section of chunk.sections) {
      const palette = source.palettesFor(chunk, section.sy).map((a) => table.idOf(a));
      const base = section.sy * 16;

      if (!section.indices) {
        if (!table.solid[palette[0]]) continue;
        occupied.push(section.sy);
        for (let ly = 0; ly < 16; ly++) {
          for (let lz = 0; lz < 16; lz++) {
            for (let lx = 0; lx < 16; lx++) volume[index(lx, base + ly, lz)] = palette[0];
          }
        }
        continue;
      }

      let any = false;
      for (let ly = 0; ly < 16; ly++) {
        for (let lz = 0; lz < 16; lz++) {
          for (let lx = 0; lx < 16; lx++) {
            const id = palette[section.indices[sectionIndex(lx, ly, lz)]];
            if (id !== 0) {
              volume[index(lx, base + ly, lz)] = id;
              if (!any && table.solid[id]) any = true;
            }
          }
        }
      }
      if (any) occupied.push(section.sy);
    }

    if (occupied.length === 0) continue;

    /* Border, filled from neighbouring chunks. Only the rows adjacent to an
       occupied section matter, so this follows the same section list. */
    const ox = chunk.cx * 16;
    const oz = chunk.cz * 16;
    const borderRows = new Set<number>();
    for (const sy of occupied) {
      for (let y = sy * 16 - 1; y <= sy * 16 + 16; y++) {
        if (y >= yLo && y <= yHi) borderRows.add(y);
      }
    }

    for (const y of borderRows) {
      for (let z = -1; z <= 16; z++) {
        for (let x = -1; x <= 16; x++) {
          if (x !== -1 && x !== 16 && z !== -1 && z !== 16) continue;
          volume[index(x, y, z)] = table.idOf(source.at(ox + x, y, oz + z));
        }
      }
    }

    const step = FACE_STEP.map(([dx, dy, dz]) => dx * SX + dy * SY + dz * SZ);

    for (const sy of occupied) {
      const base = sy * 16;
      for (let ly = 0; ly < 16; ly++) {
        const y = base + ly;
        for (let z = 0; z < 16; z++) {
          for (let x = 0; x < 16; x++) {
            blocksScanned++;
            const at = index(x, y, z);
            const id = volume[at];
            if (id === 0 || !table.solid[id]) continue;
            solid++;

            const out = table.opaque[id] ? opaqueOut : clearOut;
            const color = table.color[id];
            for (let f = 0; f < 6; f++) {
              if (table.opaque[volume[at + step[f]]]) continue;
              out.quad(ox + x, y, oz + z, f, color);
            }
          }
        }
      }
    }
  }

  return {
    opaque: opaqueOut.finish(),
    translucent: clearOut.finish(),
    faces: opaqueOut.faces + clearOut.faces,
    blocksScanned,
    solid,
    ms: performance.now() - t0
  };
}
