/**
 * `level.dat` — the world's header file.
 *
 * Gzipped NBT holding the level name, the version that last wrote it, and the
 * spawn point. Not needed to read blocks, but it is what turns "here are some
 * region files" into "here is a world, start at the spawn".
 */

import { asCompound, asNumber, asString, parseNbt, type NbtCompound } from '../anvil/nbt';
import { decompress } from '../anvil/region';

export interface LevelInfo {
  /** The name shown in the world list, not the folder name. */
  name: string;
  /** e.g. `1.21.1`. Empty when the world predates the Version compound. */
  versionName: string;
  dataVersion: number;
  spawn: { x: number; y: number; z: number };
  /** Whether the writer set `hardcore` — surfaced only as a nicety. */
  hardcore: boolean;
  /** Dimension ids declared by datapacks, if any. */
  declaredDimensions: string[];
}

/**
 * Uncompress whatever a `.dat` turns out to be.
 *
 * Vanilla gzips it, but some tools write zlib or plain NBT, and there is no
 * reason to reject a world over its container. Sniff the magic instead.
 */
async function uncompress(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return decompress(bytes, 'gzip');
  /* zlib: low nibble 8 (deflate) and the two-byte header is a multiple of 31. */
  if ((bytes[0] & 0x0f) === 0x08 && ((bytes[0] << 8) | bytes[1]) % 31 === 0) {
    return decompress(bytes, 'deflate');
  }
  return bytes;
}

function readDimensions(data: NbtCompound): string[] {
  const settings = asCompound(data.WorldGenSettings);
  const dimensions = settings && asCompound(settings.dimensions);
  return dimensions ? Object.keys(dimensions) : [];
}

export async function parseLevelDat(bytes: Uint8Array): Promise<LevelInfo> {
  const { value: root } = parseNbt(await uncompress(bytes));

  /* Everything interesting lives under `Data`; fall back to the root so a
     hand-written level.dat that skips the wrapper still works. */
  const data = asCompound(root.Data) ?? root;
  const version = asCompound(data.Version);

  return {
    name: asString(data.LevelName) ?? '',
    versionName: (version && asString(version.Name)) ?? '',
    dataVersion: asNumber(data.DataVersion) ?? 0,
    spawn: {
      x: asNumber(data.SpawnX) ?? 0,
      y: asNumber(data.SpawnY) ?? 64,
      z: asNumber(data.SpawnZ) ?? 0
    },
    hardcore: (asNumber(data.hardcore) ?? 0) === 1,
    declaredDimensions: readDimensions(data)
  };
}
