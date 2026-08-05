/**
 * A fake but structurally real world — fixtures only.
 *
 * Generates terrain, writes it through the actual region writer, so the spike
 * and any future test exercise the same parse path a real save would. Lets the
 * renderer be developed without a Minecraft installation on the machine.
 */

import { SECTION_VOLUME, sectionIndex, type BlockState } from '../chunk';
import type { FixtureChunk, FixtureSection } from './regionWrite';

const SEA_LEVEL = 62;

/** Deterministic value noise — smooth enough for terrain, no dependencies. */
function noise2d(seed: number) {
  const hash = (x: number, z: number) => {
    let h = seed ^ Math.imul(x, 374761393) ^ Math.imul(z, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const smooth = (t: number) => t * t * (3 - 2 * t);

  return (x: number, z: number) => {
    const xi = Math.floor(x);
    const zi = Math.floor(z);
    const tx = smooth(x - xi);
    const tz = smooth(z - zi);
    const a = hash(xi, zi);
    const b = hash(xi + 1, zi);
    const c = hash(xi, zi + 1);
    const d = hash(xi + 1, zi + 1);
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  };
}

const base = noise2d(1337);
const detail = noise2d(7331);
const treeNoise = noise2d(4242);

/** Exported so a test can assert the world it reads back matches what it asked
 *  for, independently of how the chunks were split across region files. */
export function heightAt(x: number, z: number): number {
  const h =
    SEA_LEVEL +
    2 +
    (base(x / 48, z / 48) - 0.45) * 46 +
    (detail(x / 11, z / 11) - 0.5) * 7;
  return Math.max(4, Math.min(120, Math.round(h)));
}

/** Accumulates blocks for one 16^3 section, interning names into a palette. */
class SectionBuilder {
  private readonly ids = new Map<string, number>();
  readonly palette: BlockState[] = [];
  readonly indices = new Uint16Array(SECTION_VOLUME);
  private used = false;

  constructor() {
    this.intern('minecraft:air');
  }

  private intern(name: string): number {
    let i = this.ids.get(name);
    if (i === undefined) {
      i = this.palette.length;
      this.ids.set(name, i);
      this.palette.push({ name });
    }
    return i;
  }

  set(x: number, y: number, z: number, name: string) {
    this.indices[sectionIndex(x, y, z)] = this.intern(name);
    this.used = true;
  }

  /** Palette index 0 is always air, so an untouched cell reads as air. */
  isAir(x: number, y: number, z: number): boolean {
    return this.indices[sectionIndex(x, y, z)] === 0;
  }

  toSection(sy: number): FixtureSection | null {
    if (!this.used) return null;
    if (this.palette.length === 1) return { sy, palette: this.palette };
    return { sy, palette: this.palette, indices: this.indices };
  }
}

function columnBlock(y: number, height: number): string | null {
  if (y === -64) return 'minecraft:bedrock';
  if (y > height) return y <= SEA_LEVEL ? 'minecraft:water' : null;

  if (y === height) {
    if (height <= SEA_LEVEL) return 'minecraft:sand';
    if (height > 96) return 'minecraft:snow_block';
    return 'minecraft:grass_block';
  }
  if (y > height - 4) return height > 96 ? 'minecraft:stone' : 'minecraft:dirt';
  if (y < 0) return 'minecraft:deepslate';

  /* A little ore so the palette is not trivially small and the colours vary. */
  const r = detail(y * 3.1, height * 1.7);
  if (r > 0.985) return 'minecraft:iron_ore';
  if (r < 0.012) return 'minecraft:coal_ore';
  return 'minecraft:stone';
}

/** Build one chunk of terrain, with the occasional tree for vertical interest. */
export function synthesiseChunk(cx: number, cz: number): FixtureChunk {
  const minSy = -4;
  const maxSy = 8;
  const builders = new Map<number, SectionBuilder>();

  const builderFor = (sy: number): SectionBuilder | null => {
    if (sy < minSy || sy > maxSy) return null;
    let b = builders.get(sy);
    if (!b) {
      b = new SectionBuilder();
      builders.set(sy, b);
    }
    return b;
  };

  const put = (wx: number, wy: number, wz: number, name: string) => {
    builderFor(wy >> 4)?.set(wx & 15, wy & 15, wz & 15, name);
  };

  /** Place only into air, the way foliage actually generates. Without this a
   *  tree's leaf canopy can overwrite the grass block of a lower neighbouring
   *  column, leaving terrain that does not match the heightmap. */
  const putSoft = (wx: number, wy: number, wz: number, name: string) => {
    const b = builderFor(wy >> 4);
    if (b && b.isAir(wx & 15, wy & 15, wz & 15)) b.set(wx & 15, wy & 15, wz & 15, name);
  };

  for (let lx = 0; lx < 16; lx++) {
    for (let lz = 0; lz < 16; lz++) {
      const wx = cx * 16 + lx;
      const wz = cz * 16 + lz;
      const h = heightAt(wx, wz);

      for (let y = -64; y <= Math.max(h, SEA_LEVEL); y++) {
        const name = columnBlock(y, h);
        if (name) put(wx, y, wz, name);
      }

      /* Trees: sparse, only on grass, and kept clear of chunk edges so the
         spike does not need cross-chunk writes. */
      if (h > SEA_LEVEL && h <= 96 && lx > 2 && lx < 13 && lz > 2 && lz < 13) {
        if (treeNoise(wx * 0.9, wz * 0.9) > 0.93) {
          const trunk = 4 + Math.floor(treeNoise(wz, wx) * 3);
          for (let i = 1; i <= trunk; i++) put(wx, h + i, wz, 'minecraft:oak_log');
          for (let dy = trunk - 2; dy <= trunk + 1; dy++) {
            const r = dy >= trunk ? 1 : 2;
            for (let dx = -r; dx <= r; dx++) {
              for (let dz = -r; dz <= r; dz++) {
                if (dx === 0 && dz === 0 && dy < trunk) continue;
                if (Math.abs(dx) === r && Math.abs(dz) === r) continue;
                putSoft(wx + dx, h + dy, wz + dz, 'minecraft:oak_leaves');
              }
            }
          }
        }
      }
    }
  }

  const sections: FixtureSection[] = [];
  for (const [sy, b] of [...builders].sort((a, c) => a[0] - c[0])) {
    const s = b.toSection(sy);
    if (s) sections.push(s);
  }
  return { cx, cz, sections };
}

/** A square of synthetic chunks, anchored at chunk (0,0) of region (0,0). */
export function synthesiseChunks(size: number): FixtureChunk[] {
  const out: FixtureChunk[] = [];
  for (let cz = 0; cz < size; cz++) {
    for (let cx = 0; cx < size; cx++) out.push(synthesiseChunk(cx, cz));
  }
  return out;
}
