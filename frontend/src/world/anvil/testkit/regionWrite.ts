/**
 * Region/chunk writer — test fixtures only, never imported by the app.
 *
 * Produces byte-real `.mca` content so the reader is exercised against the
 * actual container format (header table, sector padding, zlib framing) rather
 * than against a convenient in-memory shape.
 */

import { bitsForPalette, SECTION_VOLUME, type BlockState } from '../chunk';
import { MIN_DATA_VERSION } from '../errors';
import { CHUNKS_PER_AXIS, SECTOR } from '../region';
import {
  nCompound,
  nInt,
  nList,
  nLongArray,
  nString,
  Tagged,
  writeNbt
} from './nbtWrite';
import { TAG } from '../nbt';

/** Inverse of `unpackBlockStates`, including the no-straddling-longs rule. */
export function packBlockStates(indices: Uint16Array, paletteLength: number): bigint[] {
  const bits = bitsForPalette(paletteLength);
  const perLong = Math.floor(64 / bits);
  const longs = new Array<bigint>(Math.ceil(SECTION_VOLUME / perLong)).fill(0n);

  for (let i = 0; i < SECTION_VOLUME; i++) {
    const longIndex = Math.floor(i / perLong);
    const offset = BigInt((i % perLong) * bits);
    longs[longIndex] |= BigInt(indices[i]) << offset;
  }
  return longs.map((v) => BigInt.asIntN(64, v));
}

export interface FixtureSection {
  sy: number;
  palette: BlockState[];
  /** Omit for a uniform section — the writer then emits no `data` array. */
  indices?: Uint16Array;
}

function paletteTag(palette: BlockState[]): Tagged {
  return nList(
    TAG.Compound,
    palette.map((b) => {
      const fields: Record<string, Tagged> = { Name: nString(b.name) };
      if (b.properties) {
        const props: Record<string, Tagged> = {};
        for (const [k, v] of Object.entries(b.properties)) props[k] = nString(v);
        fields.Properties = nCompound(props);
      }
      return nCompound(fields);
    })
  );
}

export interface FixtureChunk {
  cx: number;
  cz: number;
  sections: FixtureSection[];
  dataVersion?: number;
  status?: string;
}

/** Serialise a chunk to uncompressed NBT in the 1.18+ shape. */
export function writeChunkNbt(chunk: FixtureChunk): Uint8Array {
  const sections = chunk.sections.map((s) => {
    const states: Record<string, Tagged> = { palette: paletteTag(s.palette) };
    if (s.indices && s.palette.length > 1) {
      states.data = nLongArray(packBlockStates(s.indices, s.palette.length));
    }
    return nCompound({
      Y: new Tagged(TAG.Byte, s.sy),
      block_states: nCompound(states)
    });
  });

  return writeNbt(
    '',
    nCompound({
      DataVersion: nInt(chunk.dataVersion ?? MIN_DATA_VERSION),
      xPos: nInt(chunk.cx),
      zPos: nInt(chunk.cz),
      yPos: nInt(-4),
      Status: nString(chunk.status ?? 'minecraft:full'),
      sections: nList(TAG.Compound, sections)
    })
  );
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The pre-1.18 chunk layout, for testing that we reject it with the right
 * message: everything under `Level`, capital `Sections`, `Palette` and a
 * `BlockStates` long array instead of `block_states`.
 */
export function writeLegacyChunkNbt(chunk: FixtureChunk): Uint8Array {
  const sections = chunk.sections.map((s) =>
    nCompound({
      Y: new Tagged(TAG.Byte, s.sy),
      Palette: paletteTag(s.palette),
      BlockStates: nLongArray(
        s.indices && s.palette.length > 1 ? packBlockStates(s.indices, s.palette.length) : [0n]
      )
    })
  );

  return writeNbt(
    '',
    nCompound({
      DataVersion: nInt(chunk.dataVersion ?? 2730),
      Level: nCompound({
        xPos: nInt(chunk.cx),
        zPos: nInt(chunk.cz),
        Status: nString(chunk.status ?? 'full'),
        Sections: nList(TAG.Compound, sections)
      })
    })
  );
}

/** Assemble chunks into a region file, zlib-compressed (compression type 2). */
export async function writeRegion(
  chunks: FixtureChunk[],
  encode: (chunk: FixtureChunk) => Uint8Array = writeChunkNbt
): Promise<Uint8Array> {
  const header = new Uint8Array(2 * SECTOR);
  const headerView = new DataView(header.buffer);
  const body: Uint8Array[] = [];
  let sector = 2;

  for (const chunk of chunks) {
    const compressed = await deflate(encode(chunk));

    /* 4-byte length + 1-byte compression id, padded out to whole sectors. */
    const framed = 5 + compressed.length;
    const sectors = Math.ceil(framed / SECTOR);
    const block = new Uint8Array(sectors * SECTOR);
    new DataView(block.buffer).setUint32(0, compressed.length + 1);
    block[4] = 2;
    block.set(compressed, 5);

    const lx = chunk.cx & 31;
    const lz = chunk.cz & 31;
    const slot = (lx + lz * CHUNKS_PER_AXIS) << 2;
    header[slot] = (sector >> 16) & 0xff;
    header[slot + 1] = (sector >> 8) & 0xff;
    header[slot + 2] = sector & 0xff;
    header[slot + 3] = sectors;
    headerView.setUint32(SECTOR + slot, 1700000000);

    body.push(block);
    sector += sectors;
  }

  const total = header.length + body.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  out.set(header, 0);
  let at = header.length;
  for (const b of body) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}
