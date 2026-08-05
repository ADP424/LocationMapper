/**
 * NBT reader — big-endian, uncompressed. Anvil chunk payloads are handed here
 * after the region container has inflated them.
 *
 * Isomorphic: no DOM, no Node builtins. The same code runs in the chunk worker
 * and under tsx for the fixture round-trip test.
 */

export const TAG = {
  End: 0,
  Byte: 1,
  Short: 2,
  Int: 3,
  Long: 4,
  Float: 5,
  Double: 6,
  ByteArray: 7,
  String: 8,
  List: 9,
  Compound: 10,
  IntArray: 11,
  LongArray: 12
} as const;

export type TagId = (typeof TAG)[keyof typeof TAG];

/**
 * A TAG_Long_Array kept as raw big-endian bytes rather than a BigInt64Array.
 *
 * Block-state unpacking is the hottest loop in the whole pipeline and it only
 * ever needs 32-bit halves, so materialising BigInts here would be pure waste.
 * `view` is positioned at the first long; `count` is the number of longs.
 */
export class NbtLongArray {
  constructor(
    readonly view: DataView,
    readonly count: number
  ) {}

  /** High 32 bits of long `i`. */
  hi(i: number): number {
    return this.view.getUint32(i << 3);
  }

  /** Low 32 bits of long `i`. */
  lo(i: number): number {
    return this.view.getUint32((i << 3) + 4);
  }
}

export type NbtValue =
  | number
  | bigint
  | string
  | Uint8Array
  | Int32Array
  | NbtLongArray
  | NbtList
  | NbtCompound;

export interface NbtCompound {
  [key: string]: NbtValue;
}

export type NbtList = NbtValue[];

/* ------------------------------------------------------------- utf-8 (mod) */

const ascii = new TextDecoder('utf-8');

/**
 * Java's "modified UTF-8": U+0000 is encoded as C0 80, and astral characters
 * arrive as a surrogate pair of two 3-byte sequences rather than one 4-byte
 * sequence. Standard TextDecoder mangles both, so anything non-ASCII takes the
 * manual path. Block and tag names are ASCII, so that path is effectively only
 * for level names.
 */
function decodeString(bytes: Uint8Array, start: number, len: number): string {
  const end = start + len;
  let plain = true;
  for (let i = start; i < end; i++) {
    if (bytes[i] >= 0x80) {
      plain = false;
      break;
    }
  }
  if (plain) return ascii.decode(bytes.subarray(start, end));

  let out = '';
  let i = start;
  while (i < end) {
    const a = bytes[i];
    if (a < 0x80) {
      out += String.fromCharCode(a);
      i += 1;
    } else if ((a & 0xe0) === 0xc0) {
      out += String.fromCharCode(((a & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else {
      out += String.fromCharCode(
        ((a & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)
      );
      i += 3;
    }
  }
  return out;
}

/* -------------------------------------------------------------------- read */

class Reader {
  readonly view: DataView;
  pos = 0;

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u8(): number {
    return this.bytes[this.pos++];
  }

  i8(): number {
    return this.view.getInt8(this.pos++);
  }

  i16(): number {
    const v = this.view.getInt16(this.pos);
    this.pos += 2;
    return v;
  }

  u16(): number {
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }

  i32(): number {
    const v = this.view.getInt32(this.pos);
    this.pos += 4;
    return v;
  }

  i64(): bigint {
    const v = this.view.getBigInt64(this.pos);
    this.pos += 8;
    return v;
  }

  f32(): number {
    const v = this.view.getFloat32(this.pos);
    this.pos += 4;
    return v;
  }

  f64(): number {
    const v = this.view.getFloat64(this.pos);
    this.pos += 8;
    return v;
  }

  str(): string {
    const len = this.u16();
    const s = decodeString(this.bytes, this.pos, len);
    this.pos += len;
    return s;
  }
}

function readPayload(r: Reader, tag: number): NbtValue {
  switch (tag) {
    case TAG.Byte:
      return r.i8();
    case TAG.Short:
      return r.i16();
    case TAG.Int:
      return r.i32();
    case TAG.Long:
      return r.i64();
    case TAG.Float:
      return r.f32();
    case TAG.Double:
      return r.f64();

    case TAG.ByteArray: {
      const len = r.i32();
      const out = r.bytes.subarray(r.pos, r.pos + len);
      r.pos += len;
      return out;
    }

    case TAG.String:
      return r.str();

    case TAG.List: {
      const itemTag = r.u8();
      const len = r.i32();
      const out: NbtList = [];
      /* An empty list is written with tag End; nothing to read either way. */
      if (len <= 0) return out;
      for (let i = 0; i < len; i++) out.push(readPayload(r, itemTag));
      return out;
    }

    case TAG.Compound: {
      const out: NbtCompound = {};
      for (;;) {
        const t = r.u8();
        if (t === TAG.End) break;
        const name = r.str();
        out[name] = readPayload(r, t);
      }
      return out;
    }

    case TAG.IntArray: {
      const len = r.i32();
      /* Int32Array needs 4-byte alignment the buffer cannot promise, and it
         would be little-endian anyway — copy through the DataView. */
      const out = new Int32Array(len);
      for (let i = 0; i < len; i++) out[i] = r.view.getInt32(r.pos + (i << 2));
      r.pos += len << 2;
      return out;
    }

    case TAG.LongArray: {
      const len = r.i32();
      const view = new DataView(r.bytes.buffer, r.bytes.byteOffset + r.pos, len << 3);
      r.pos += len << 3;
      return new NbtLongArray(view, len);
    }

    default:
      throw new Error(`NBT: unknown tag id ${tag} at byte ${r.pos - 1}`);
  }
}

export interface NbtRoot {
  name: string;
  value: NbtCompound;
}

/** Parse an uncompressed NBT document. Anvil roots are always a compound. */
export function parseNbt(bytes: Uint8Array): NbtRoot {
  const r = new Reader(bytes);
  const tag = r.u8();
  if (tag !== TAG.Compound) throw new Error(`NBT: root tag is ${tag}, expected compound`);
  const name = r.str();
  return { name, value: readPayload(r, TAG.Compound) as NbtCompound };
}

/* ------------------------------------------------------------- accessors */
/* NbtValue is a wide union; these keep the callers free of casts. */

export function asCompound(v: NbtValue | undefined): NbtCompound | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v) &&
    !(v instanceof NbtLongArray)
    ? (v as NbtCompound)
    : undefined;
}

export function asList(v: NbtValue | undefined): NbtList | undefined {
  return Array.isArray(v) ? v : undefined;
}

export function asNumber(v: NbtValue | undefined): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  return undefined;
}

export function asString(v: NbtValue | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function asLongArray(v: NbtValue | undefined): NbtLongArray | undefined {
  return v instanceof NbtLongArray ? v : undefined;
}
