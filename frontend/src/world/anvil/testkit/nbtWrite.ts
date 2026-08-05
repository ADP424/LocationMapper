/**
 * NBT writer — test fixtures only, never imported by the app.
 *
 * The reader has to be fast and is therefore full of assumptions; this exists
 * to generate byte-exact input that exercises those assumptions on purpose.
 * Correctness over speed throughout (BigInt is fine here).
 */

import { TAG } from '../nbt';

export class Tagged {
  constructor(
    readonly tag: number,
    readonly value: unknown
  ) {}
}

export const nByte = (v: number) => new Tagged(TAG.Byte, v);
export const nShort = (v: number) => new Tagged(TAG.Short, v);
export const nInt = (v: number) => new Tagged(TAG.Int, v);
export const nLong = (v: bigint) => new Tagged(TAG.Long, v);
export const nFloat = (v: number) => new Tagged(TAG.Float, v);
export const nDouble = (v: number) => new Tagged(TAG.Double, v);
export const nString = (v: string) => new Tagged(TAG.String, v);
export const nByteArray = (v: Uint8Array | number[]) => new Tagged(TAG.ByteArray, v);
export const nIntArray = (v: number[]) => new Tagged(TAG.IntArray, v);
export const nLongArray = (v: bigint[]) => new Tagged(TAG.LongArray, v);
export const nCompound = (v: Record<string, Tagged>) => new Tagged(TAG.Compound, v);

/** `itemTag` is explicit so empty lists round-trip with the right element type. */
export const nList = (itemTag: number, items: Tagged[]) =>
  new Tagged(TAG.List, { itemTag, items });

interface ListPayload {
  itemTag: number;
  items: Tagged[];
}

/* ------------------------------------------------------------ byte sink */

class Writer {
  private buf = new Uint8Array(1 << 16);
  private view = new DataView(this.buf.buffer);
  private pos = 0;

  private need(n: number) {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.pos + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number) {
    this.need(1);
    this.buf[this.pos++] = v & 0xff;
  }

  i16(v: number) {
    this.need(2);
    this.view.setInt16(this.pos, v);
    this.pos += 2;
  }

  i32(v: number) {
    this.need(4);
    this.view.setInt32(this.pos, v);
    this.pos += 4;
  }

  i64(v: bigint) {
    this.need(8);
    this.view.setBigInt64(this.pos, BigInt.asIntN(64, v));
    this.pos += 8;
  }

  f32(v: number) {
    this.need(4);
    this.view.setFloat32(this.pos, v);
    this.pos += 4;
  }

  f64(v: number) {
    this.need(8);
    this.view.setFloat64(this.pos, v);
    this.pos += 8;
  }

  /** Modified UTF-8: ASCII fast path is all the fixtures need, but encode
   *  U+0000 as C0 80 so the reader's slow path gets exercised if asked. */
  str(v: string) {
    const bytes: number[] = [];
    for (const ch of v) {
      const c = ch.codePointAt(0)!;
      if (c === 0) bytes.push(0xc0, 0x80);
      else if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    this.i16(bytes.length);
    this.need(bytes.length);
    for (const b of bytes) this.buf[this.pos++] = b;
  }

  raw(v: Uint8Array) {
    this.need(v.length);
    this.buf.set(v, this.pos);
    this.pos += v.length;
  }

  done(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

function writePayload(w: Writer, t: Tagged) {
  switch (t.tag) {
    case TAG.Byte:
      w.u8(t.value as number);
      break;
    case TAG.Short:
      w.i16(t.value as number);
      break;
    case TAG.Int:
      w.i32(t.value as number);
      break;
    case TAG.Long:
      w.i64(t.value as bigint);
      break;
    case TAG.Float:
      w.f32(t.value as number);
      break;
    case TAG.Double:
      w.f64(t.value as number);
      break;

    case TAG.ByteArray: {
      const v = t.value as Uint8Array | number[];
      w.i32(v.length);
      w.raw(v instanceof Uint8Array ? v : Uint8Array.from(v));
      break;
    }

    case TAG.String:
      w.str(t.value as string);
      break;

    case TAG.List: {
      const { itemTag, items } = t.value as ListPayload;
      w.u8(items.length === 0 ? TAG.End : itemTag);
      w.i32(items.length);
      for (const it of items) writePayload(w, it);
      break;
    }

    case TAG.Compound: {
      const v = t.value as Record<string, Tagged>;
      for (const [k, child] of Object.entries(v)) {
        w.u8(child.tag);
        w.str(k);
        writePayload(w, child);
      }
      w.u8(TAG.End);
      break;
    }

    case TAG.IntArray: {
      const v = t.value as number[];
      w.i32(v.length);
      for (const n of v) w.i32(n);
      break;
    }

    case TAG.LongArray: {
      const v = t.value as bigint[];
      w.i32(v.length);
      for (const n of v) w.i64(n);
      break;
    }

    default:
      throw new Error(`nbtWrite: unhandled tag ${t.tag}`);
  }
}

/** Serialise a root compound to uncompressed NBT bytes. */
export function writeNbt(name: string, root: Tagged): Uint8Array {
  if (root.tag !== TAG.Compound) throw new Error('nbtWrite: root must be a compound');
  const w = new Writer();
  w.u8(TAG.Compound);
  w.str(name);
  writePayload(w, root);
  return w.done();
}
