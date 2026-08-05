/**
 * Anvil region container (`r.<rx>.<rz>.mca`).
 *
 * Layout: 8 KiB of header, then 4096-byte sectors of chunk payloads.
 *   - bytes 0..4095      1024 x [u24 BE sector offset, u8 sector count]
 *   - bytes 4096..8191   1024 x u32 BE mtime
 *   - at offset*4096     u32 BE length, u8 compression, then `length - 1` bytes
 *
 * A region covers 32x32 chunks = 512x512 blocks. Chunk slots are addressed
 * locally (0..31); `index = lx + lz * 32`.
 */

import { AnvilError } from './errors';

export const SECTOR = 4096;
export const CHUNKS_PER_AXIS = 32;
export const BLOCKS_PER_REGION_AXIS = CHUNKS_PER_AXIS * 16;

const COMPRESSION_GZIP = 1;
const COMPRESSION_ZLIB = 2;
const COMPRESSION_NONE = 3;
const COMPRESSION_LZ4 = 4;
/** High bit means the payload lives in a sibling `c.<x>.<z>.mcc` file. */
const EXTERNAL_FLAG = 0x80;

/** Parse `r.-1.4.mca` into region coordinates. Returns null for other names. */
export function parseRegionName(name: string): { rx: number; rz: number } | null {
  const m = /^r\.(-?\d+)\.(-?\d+)\.mca$/.exec(name);
  return m ? { rx: Number(m[1]), rz: Number(m[2]) } : null;
}

export const regionOf = (chunkCoord: number) => chunkCoord >> 5;
export const localOf = (chunkCoord: number) => chunkCoord & 31;

/** Inflate with the platform codec — no pako, no zlib dependency. */
export async function decompress(
  data: Uint8Array,
  format: 'deflate' | 'gzip'
): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface ChunkSlot {
  /** Local chunk coordinates within the region, 0..31. */
  lx: number;
  lz: number;
  offsetSectors: number;
  sectorCount: number;
  /** Seconds since epoch, as written by the server. */
  timestamp: number;
}

/**
 * Chunk slots read from the 8 KiB header alone.
 *
 * A region file can be several megabytes, but its header says exactly which
 * chunks it holds. Reading just that prefix lets a caller decide which region
 * files are worth fetching in full — the difference between pulling one region
 * and pulling a whole world off disk.
 */
export function listChunkSlots(header: Uint8Array): ChunkSlot[] {
  if (header.byteLength < 2 * SECTOR) {
    throw new AnvilError(
      'bad-region',
      `Need the full 8 KiB header to list chunks, got ${header.byteLength} bytes.`
    );
  }
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const out: ChunkSlot[] = [];

  for (let i = 0; i < CHUNKS_PER_AXIS * CHUNKS_PER_AXIS; i++) {
    const b = i << 2;
    const offsetSectors = (header[b] << 16) | (header[b + 1] << 8) | header[b + 2];
    const sectorCount = header[b + 3];
    /* Tolerant on purpose: a corrupt entry here should cost one chunk, not the
       whole world. `readChunk` still validates before touching the payload. */
    if (offsetSectors < 2 || sectorCount === 0) continue;
    out.push({
      lx: i % CHUNKS_PER_AXIS,
      lz: Math.floor(i / CHUNKS_PER_AXIS),
      offsetSectors,
      sectorCount,
      timestamp: view.getUint32(SECTOR + b)
    });
  }
  return out;
}

export class RegionFile {
  private readonly view: DataView;

  constructor(
    readonly bytes: Uint8Array,
    readonly rx = 0,
    readonly rz = 0
  ) {
    if (bytes.byteLength < 2 * SECTOR) {
      throw new AnvilError(
        'bad-region',
        `Region file is ${bytes.byteLength} bytes, too small to hold its 8 KiB header.`
      );
    }
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private slotIndex(lx: number, lz: number) {
    return lx + lz * CHUNKS_PER_AXIS;
  }

  /** Header entry for a local chunk slot, or null when the chunk is ungenerated. */
  slot(lx: number, lz: number): ChunkSlot | null {
    const i = this.slotIndex(lx, lz);
    const b = i << 2;
    const offsetSectors = (this.bytes[b] << 16) | (this.bytes[b + 1] << 8) | this.bytes[b + 2];
    const sectorCount = this.bytes[b + 3];
    if (offsetSectors === 0 && sectorCount === 0) return null;
    if (offsetSectors < 2) {
      throw new AnvilError(
        'bad-region',
        `Chunk (${lx}, ${lz}) claims to start at sector ${offsetSectors}, inside the header.`
      );
    }
    return {
      lx,
      lz,
      offsetSectors,
      sectorCount,
      timestamp: this.view.getUint32(SECTOR + (i << 2))
    };
  }

  /** Every generated chunk slot in this region. */
  slots(): ChunkSlot[] {
    const out: ChunkSlot[] = [];
    for (let lz = 0; lz < CHUNKS_PER_AXIS; lz++) {
      for (let lx = 0; lx < CHUNKS_PER_AXIS; lx++) {
        const s = this.slot(lx, lz);
        if (s) out.push(s);
      }
    }
    return out;
  }

  /**
   * Inflated NBT bytes for a local chunk slot, or null when ungenerated.
   *
   * Truncated region files are common on servers that were killed mid-save, so
   * a short read is reported as `incomplete-chunk` rather than throwing a
   * RangeError from the DataView.
   */
  async readChunk(lx: number, lz: number): Promise<Uint8Array | null> {
    const s = this.slot(lx, lz);
    if (!s) return null;

    const at = s.offsetSectors * SECTOR;
    if (at + 5 > this.bytes.byteLength) {
      throw new AnvilError(
        'incomplete-chunk',
        `Chunk (${lx}, ${lz}) starts past the end of the region file — the file is truncated.`
      );
    }

    const length = this.view.getUint32(at);
    const compression = this.bytes[at + 4];
    const payloadStart = at + 5;
    const payloadLength = length - 1;

    if (compression & EXTERNAL_FLAG) {
      const cx = this.rx * CHUNKS_PER_AXIS + lx;
      const cz = this.rz * CHUNKS_PER_AXIS + lz;
      throw new AnvilError(
        'external-chunk',
        `Chunk (${cx}, ${cz}) is stored outside the region file in c.${cx}.${cz}.mcc, which is not supported yet.`
      );
    }

    if (payloadLength < 0 || payloadStart + payloadLength > this.bytes.byteLength) {
      throw new AnvilError(
        'incomplete-chunk',
        `Chunk (${lx}, ${lz}) declares ${payloadLength} bytes but the region file ends first.`
      );
    }

    const payload = this.bytes.subarray(payloadStart, payloadStart + payloadLength);

    switch (compression) {
      case COMPRESSION_ZLIB:
        return decompress(payload, 'deflate');
      case COMPRESSION_GZIP:
        return decompress(payload, 'gzip');
      case COMPRESSION_NONE:
        return payload;
      case COMPRESSION_LZ4:
        throw new AnvilError(
          'unsupported-compression',
          'This world uses LZ4 chunk compression, which is not supported yet. Set `region-file-compression=deflate` in server.properties and re-save the world.'
        );
      default:
        throw new AnvilError(
          'unsupported-compression',
          `Chunk (${lx}, ${lz}) uses unknown compression type ${compression}.`
        );
    }
  }
}
