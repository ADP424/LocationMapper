/**
 * The set of chunks currently held in memory, and random access across them.
 *
 * The area loader used to hand the mesher every chunk at once, which is fine
 * when the answer is one static mesh but not when chunks arrive and leave
 * continuously. This is the same idea rebuilt around a keyed, mutable set: a
 * chunk can be added, meshed on its own, and dropped without touching anything
 * else.
 *
 * A key point of the design is that an *absent* chunk is recorded, not just
 * missing from the map. The mesher culls faces at a chunk seam by reading one
 * block into the neighbour, so it matters whether a neighbour is "not loaded
 * yet" (wait for it) or "does not exist in this world" (treat as air, mesh now).
 */

import { appearanceOf, type BlockAppearance } from '../anvil/blocks';
import { sectionIndex, type ChunkSection, type ParsedChunk } from '../anvil/chunk';
import type { BlockSource } from '../mesh/faces';

export const AIR: BlockAppearance = { solid: false, opaque: false, color: 0, alpha: 0 };

/**
 * Chunk coordinates packed into one safe integer, so the hot maps are keyed by
 * number rather than by a freshly built `"cx,cz"` string.
 *
 * Injective for |c| < 2^23 chunks, which is 134 million blocks from origin —
 * comfortably past Minecraft's own 30 million block world border.
 */
export const chunkKey = (cx: number, cz: number) =>
  (cx & 0xffffff) * 0x1000000 + (cz & 0xffffff);

interface Entry {
  chunk: ParsedChunk;
  /** Palette resolved to appearances once per section, not once per block. */
  appearances: Map<number, BlockAppearance[]>;
  /** Cheap `at()` lookups: section by `sy`, avoiding a linear scan per block. */
  bySy: Map<number, ChunkSection>;
}

export class ChunkStore {
  private readonly loaded = new Map<number, Entry>();
  /** Chunks the region headers say do not exist. Keeps them from being retried
   *  every pass, and lets a neighbouring chunk mesh instead of waiting. */
  private readonly absent = new Set<number>();

  get size(): number {
    return this.loaded.size;
  }

  has(cx: number, cz: number): boolean {
    return this.loaded.has(chunkKey(cx, cz));
  }

  /** Loaded or known not to exist — either way, nothing more to fetch. */
  resolved(cx: number, cz: number): boolean {
    const k = chunkKey(cx, cz);
    return this.loaded.has(k) || this.absent.has(k);
  }

  get(cx: number, cz: number): ParsedChunk | undefined {
    return this.loaded.get(chunkKey(cx, cz))?.chunk;
  }

  add(chunk: ParsedChunk) {
    const appearances = new Map<number, BlockAppearance[]>();
    const bySy = new Map<number, ChunkSection>();
    for (const s of chunk.sections) {
      appearances.set(
        s.sy,
        s.palette.map((b) => appearanceOf(b.name))
      );
      bySy.set(s.sy, s);
    }
    this.loaded.set(chunkKey(chunk.cx, chunk.cz), { chunk, appearances, bySy });
  }

  markAbsent(cx: number, cz: number) {
    this.absent.add(chunkKey(cx, cz));
  }

  drop(cx: number, cz: number) {
    this.loaded.delete(chunkKey(cx, cz));
  }

  keys(): IterableIterator<number> {
    return this.loaded.keys();
  }

  clear() {
    this.loaded.clear();
    this.absent.clear();
  }

  /* ------------------------------------------------------- BlockSource */

  private palettesFor(chunk: ParsedChunk, sy: number): BlockAppearance[] {
    return this.loaded.get(chunkKey(chunk.cx, chunk.cz))!.appearances.get(sy)!;
  }

  /** Appearance at world coordinates; air anywhere nothing is loaded. */
  private at(wx: number, wy: number, wz: number): BlockAppearance {
    const entry = this.loaded.get(chunkKey(wx >> 4, wz >> 4));
    if (!entry) return AIR;

    const sy = wy >> 4;
    const section = entry.bySy.get(sy);
    if (!section) return AIR;

    const palette = entry.appearances.get(sy)!;
    const index = section.indices ? section.indices[sectionIndex(wx & 15, wy & 15, wz & 15)] : 0;
    return palette[index] ?? AIR;
  }

  /**
   * A view of the store that meshes exactly one chunk, with neighbours visible
   * for seam culling. `meshWorld` walks `list`, so a single-entry list is a
   * single-chunk mesh with no other change to the mesher.
   */
  sourceFor(chunk: ParsedChunk): BlockSource {
    return {
      list: [chunk],
      palettesFor: (c, sy) => this.palettesFor(c, sy),
      at: (x, y, z) => this.at(x, y, z)
    };
  }
}
