/**
 * Chunk NBT -> palette + block indices, for Minecraft 1.18 and newer.
 *
 * A chunk is a stack of 16x16x16 sections. Each section carries a palette of
 * block states and a bit-packed index per block, ordered YZX. Since 1.16 an
 * entry never straddles two longs — the leftover high bits of each long are
 * simply wasted — but an entry *can* straddle the two 32-bit halves of one
 * long, which is why the unpacker below reads words rather than BigInts.
 */

import { AnvilError, legacyChunkFormat, MIN_DATA_VERSION, unsupportedVersion } from './errors';
import {
  asCompound,
  asList,
  asLongArray,
  asNumber,
  asString,
  type NbtCompound,
  type NbtLongArray,
  parseNbt
} from './nbt';

export const SECTION_AXIS = 16;
export const SECTION_VOLUME = SECTION_AXIS ** 3;

/** 1.18+ world bounds. Sections run y = -4 .. 19. */
export const WORLD_MIN_Y = -64;
export const WORLD_MAX_Y = 319;

export interface BlockState {
  /** Namespaced id, e.g. `minecraft:oak_stairs`. */
  name: string;
  /** Present only when the state has any; most blocks have none. */
  properties?: Record<string, string>;
}

export interface ChunkSection {
  /** Section index. The section spans world Y `sy * 16` .. `sy * 16 + 15`. */
  sy: number;
  palette: BlockState[];
  /**
   * 4096 palette indices in YZX order, or null when the whole section is one
   * block (`palette.length === 1`). Most sections in a world are a null-indices
   * air section, so callers must handle this case — it is the common one, not
   * an edge case.
   */
  indices: Uint16Array | null;
}

export interface ParsedChunk {
  /** Chunk coordinates in the world (not local to the region). */
  cx: number;
  cz: number;
  dataVersion: number;
  status: string;
  /** Non-empty sections, ascending by `sy`. */
  sections: ChunkSection[];
}

/* ------------------------------------------------------------- unpacking */

/** Bits per packed entry: 4 minimum, otherwise ceil(log2(paletteLength)). */
export function bitsForPalette(paletteLength: number): number {
  if (paletteLength <= 16) return 4;
  return 32 - Math.clz32(paletteLength - 1);
}

/**
 * Expand a bit-packed block-state array into one index per block.
 *
 * The hottest loop in the pipeline: this runs for every non-uniform section of
 * every chunk. It walks longs in the outer loop and slots in the inner so the
 * two 32-bit halves are fetched once per long rather than once per block.
 */
export function unpackBlockStates(
  data: NbtLongArray,
  paletteLength: number,
  out: Uint16Array = new Uint16Array(SECTION_VOLUME)
): Uint16Array {
  const bits = bitsForPalette(paletteLength);
  const perLong = Math.floor(64 / bits);
  const mask = bits >= 32 ? 0xffffffff : (1 << bits) - 1;

  const needed = Math.ceil(SECTION_VOLUME / perLong);
  if (data.count < needed) {
    throw new AnvilError(
      'bad-chunk',
      `Block state array has ${data.count} longs, need ${needed} for a ${bits}-bit palette of ${paletteLength}.`
    );
  }

  let at = 0;
  for (let i = 0; i < needed; i++) {
    const lo = data.lo(i);
    const hi = data.hi(i);
    let offset = 0;
    for (let s = 0; s < perLong && at < SECTION_VOLUME; s++, offset += bits) {
      let v: number;
      if (offset + bits <= 32) v = (lo >>> offset) & mask;
      else if (offset >= 32) v = (hi >>> (offset - 32)) & mask;
      /* Straddles the halves: offset is in 1..31 here, so neither shift below
         hits the JS `<< 32 === << 0` trap. */
      else v = ((lo >>> offset) | (hi << (32 - offset))) & mask;
      out[at++] = v;
    }
  }
  return out;
}

/* --------------------------------------------------------------- parsing */

function readPalette(list: NbtCompound[]): BlockState[] {
  return list.map((entry) => {
    const name = asString(entry.Name);
    if (name === undefined) throw new AnvilError('bad-chunk', 'Palette entry has no Name.');
    const props = asCompound(entry.Properties);
    if (!props) return { name };
    const properties: Record<string, string> = {};
    for (const [k, v] of Object.entries(props)) properties[k] = String(v);
    return { name, properties };
  });
}

function readSection(raw: NbtCompound): ChunkSection | null {
  const sy = asNumber(raw.Y);
  if (sy === undefined) return null;

  const states = asCompound(raw.block_states);
  if (!states) return null;

  const paletteList = asList(states.palette);
  if (!paletteList || paletteList.length === 0) return null;

  const palette = readPalette(paletteList as NbtCompound[]);

  /* A single-entry palette carries no data array: the section is uniform. */
  const data = asLongArray(states.data);
  if (palette.length === 1 || !data) return { sy, palette, indices: null };

  return { sy, palette, indices: unpackBlockStates(data, palette.length) };
}

/** Parse inflated chunk NBT. Throws AnvilError for anything unsupported. */
export function parseChunk(nbtBytes: Uint8Array): ParsedChunk {
  const { value: root } = parseNbt(nbtBytes);

  const dataVersion = asNumber(root.DataVersion) ?? 0;
  /* Check the shape before the number: a hand-generated world can carry a
     modern DataVersion on an old layout, and vice versa. The layout is what
     actually decides whether the rest of this function can work. */
  if (asCompound(root.Level)) throw legacyChunkFormat(dataVersion);
  if (dataVersion < MIN_DATA_VERSION) throw unsupportedVersion(dataVersion);

  const cx = asNumber(root.xPos);
  const cz = asNumber(root.zPos);
  if (cx === undefined || cz === undefined) {
    throw new AnvilError('bad-chunk', 'Chunk NBT is missing xPos/zPos.');
  }

  const status = asString(root.Status) ?? '';
  const sections: ChunkSection[] = [];

  for (const raw of asList(root.sections) ?? []) {
    const compound = asCompound(raw);
    if (!compound) continue;
    const section = readSection(compound);
    if (section) sections.push(section);
  }

  sections.sort((a, b) => a.sy - b.sy);
  return { cx, cz, dataVersion, status, sections };
}

/**
 * Whether the chunk is worth drawing.
 *
 * Vanilla marks a finished chunk `minecraft:full`, but a programmatically
 * generated world often writes no Status at all — so an absent Status counts as
 * renderable. Only an explicitly partial stage is skipped, and then only when
 * the chunk would look wrong rather than merely unlit.
 */
const PARTIAL_STATUSES = new Set([
  'empty',
  'structure_starts',
  'structure_references',
  'biomes',
  'noise'
]);

export function isRenderable(chunk: ParsedChunk): boolean {
  if (chunk.sections.length === 0) return false;
  if (chunk.status === '') return true;
  const stage = chunk.status.replace(/^minecraft:/, '');
  return !PARTIAL_STATUSES.has(stage);
}

/* -------------------------------------------------------------- sampling */

/** Index of a block within a section's YZX-ordered array. */
export const sectionIndex = (x: number, y: number, z: number) =>
  (y << 8) | (z << 4) | x;

/**
 * Block state at chunk-local `x`/`z` (0..15) and absolute world `y`.
 * Returns null above/below the loaded sections — treat that as air.
 */
export function blockAt(
  chunk: ParsedChunk,
  x: number,
  y: number,
  z: number
): BlockState | null {
  const sy = y >> 4;
  const section = chunk.sections.find((s) => s.sy === sy);
  if (!section) return null;
  if (!section.indices) return section.palette[0];
  return section.palette[section.indices[sectionIndex(x, y & 15, z)]];
}
