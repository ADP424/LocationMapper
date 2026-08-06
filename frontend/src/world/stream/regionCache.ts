/**
 * Region files, fetched once and kept while they are still nearby.
 *
 * A region is 32x32 chunks and a few megabytes; a camera crossing a chunk
 * boundary must not re-fetch one. Headers are cached separately and forever,
 * because they are 8 KiB each and answer the question asked most often — does
 * this chunk exist at all — without touching the body.
 */

import { CHUNKS_PER_AXIS, listChunkSlots, RegionFile } from '../anvil/region';
import type { DimensionRef, RegionRef } from '../source/worldSource';
import { chunkKey } from './chunkStore';

/** Region bodies held at once, in bytes. Roughly 25 regions of a dense world. */
const DEFAULT_BUDGET = 96 * 1024 * 1024;

interface Held {
  file: RegionFile;
  bytes: number;
  /** Monotonic counter, not a clock: cheaper and immune to a coarse timer. */
  used: number;
}

export class RegionCache {
  private readonly byCoord = new Map<string, RegionRef>();
  private readonly headers = new Map<string, Set<number> | null>();
  private readonly headerLoads = new Map<string, Promise<Set<number> | null>>();
  private readonly bodies = new Map<string, Held>();
  private readonly bodyLoads = new Map<string, Promise<RegionFile | null>>();
  private held = 0;
  private clock = 0;

  bytesFetched = 0;
  regionsFetched = 0;

  constructor(dimension: DimensionRef, private readonly budget = DEFAULT_BUDGET) {
    for (const r of dimension.regions) this.byCoord.set(`${r.rx},${r.rz}`, r);
  }

  get bodiesHeld(): number {
    return this.bodies.size;
  }

  get bytesHeld(): number {
    return this.held;
  }

  /** The region file that would contain this chunk, if the world has one. */
  regionFor(cx: number, cz: number): RegionRef | undefined {
    return this.byCoord.get(
      `${Math.floor(cx / CHUNKS_PER_AXIS)},${Math.floor(cz / CHUNKS_PER_AXIS)}`
    );
  }

  /**
   * Keys of the chunks a region actually contains. Null if the header could not
   * be read, which is treated the same as the region not existing.
   */
  async chunkKeys(ref: RegionRef): Promise<Set<number> | null> {
    const cached = this.headers.get(ref.name);
    if (cached !== undefined) return cached;

    let pending = this.headerLoads.get(ref.name);
    if (!pending) {
      pending = (async () => {
        let keys: Set<number> | null;
        try {
          keys = new Set(
            listChunkSlots(await ref.header()).map((s) =>
              chunkKey(ref.rx * CHUNKS_PER_AXIS + s.lx, ref.rz * CHUNKS_PER_AXIS + s.lz)
            )
          );
        } catch {
          keys = null;
        }
        this.headers.set(ref.name, keys);
        this.headerLoads.delete(ref.name);
        return keys;
      })();
      this.headerLoads.set(ref.name, pending);
    }
    return pending;
  }

  /** The whole region, fetched if it is not already held. */
  async file(ref: RegionRef): Promise<RegionFile | null> {
    const held = this.bodies.get(ref.name);
    if (held) {
      held.used = ++this.clock;
      return held.file;
    }

    let pending = this.bodyLoads.get(ref.name);
    if (!pending) {
      pending = (async () => {
        let entry: Held | null = null;
        try {
          const bytes = await ref.bytes();
          entry = {
            file: new RegionFile(bytes, ref.rx, ref.rz),
            bytes: bytes.byteLength,
            used: ++this.clock
          };
          this.bytesFetched += bytes.byteLength;
          this.regionsFetched++;
        } catch {
          entry = null;
        }
        this.bodyLoads.delete(ref.name);
        if (!entry) return null;

        this.bodies.set(ref.name, entry);
        this.held += entry.bytes;
        this.trim();
        return entry.file;
      })();
      this.bodyLoads.set(ref.name, pending);
    }
    return pending;
  }

  /** Drop least-recently-used bodies until back inside the byte budget. */
  private trim() {
    if (this.held <= this.budget) return;
    const order = [...this.bodies].sort((a, b) => a[1].used - b[1].used);
    for (const [name, entry] of order) {
      if (this.held <= this.budget) break;
      this.bodies.delete(name);
      this.held -= entry.bytes;
    }
  }

  clear() {
    this.bodies.clear();
    this.held = 0;
  }
}
