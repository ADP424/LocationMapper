/**
 * Camera-driven chunk streaming: load what is near, mesh it, drop what is not.
 *
 * The measured ceiling for this world is about 1000 chunks of geometry at once,
 * against 72,909 chunks in the world — so "load the whole world" is not a thing
 * that can be done, and the honest version of it is to make the loaded window
 * follow the camera fast enough that the boundary is never what you notice. At
 * a render distance of 12 that window is 625 chunk columns, the same as
 * Minecraft's own default.
 *
 * Three rules make the result correct rather than merely fast:
 *
 *   - A chunk meshes only once all four of its side neighbours are *resolved* —
 *     loaded, or known from the region header not to exist. Meshing earlier
 *     draws a wall along the seam that a later neighbour cannot remove.
 *   - Data is therefore loaded one chunk further out than geometry is built, so
 *     chunks at the edge of the visible window have neighbours to be culled
 *     against.
 *   - Eviction runs a couple of chunks beyond loading. Without that gap, walking
 *     back and forth across one boundary re-fetches the same region forever.
 *
 * All of the work is time-sliced against the frame: the pump does a few
 * milliseconds, yields, and picks up where it left off. Nothing here blocks the
 * render loop, so the camera keeps moving while the world fills in.
 */

import * as THREE from 'three';

import { isRenderable, parseChunk, type ParsedChunk } from '../anvil/chunk';
import { CHUNKS_PER_AXIS } from '../anvil/region';
import { meshWorld, type FaceBuffers } from '../mesh/faces';
import type { DimensionRef } from '../source/worldSource';
import { chunkKey, ChunkStore } from './chunkStore';
import { RegionCache } from './regionCache';

/** Geometry is built this far in; data is loaded one ring further. */
const DATA_MARGIN = 1;
/** Extra rings kept before eviction, so a boundary crossing is not a reload. */
const EVICT_MARGIN = 3;

/** Work done per pump step before yielding to the renderer. */
const STEP_BUDGET_MS = 6;

export interface StreamStats {
  /** Chunks whose block data is in memory. */
  loaded: number;
  /** Chunks with geometry in the scene. */
  meshed: number;
  /** Chunks inside the render distance still waiting on data or neighbours. */
  pending: number;
  faces: number;
  vertexBytes: number;
  regionsFetched: number;
  bytesFetched: number;
  regionsHeld: number;
  bytesHeld: number;
  /** False once every chunk in range is meshed. */
  working: boolean;
}

export interface StreamerOptions {
  radius?: number;
  onStats?: (stats: StreamStats) => void;
  onError?: (message: string) => void;
}

interface Tile {
  meshes: THREE.Mesh[];
  faces: number;
  bytes: number;
}

type Ring = Array<{ cx: number; cz: number; key: number; d: number }>;

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

export class WorldStreamer {
  private readonly store = new ChunkStore();
  private readonly regions: RegionCache;
  private readonly tiles = new Map<number, Tile>();
  private readonly group = new THREE.Group();

  /* One material per pass, shared by every tile. Per-mesh materials would be
     hundreds of identical shader programs and hundreds of disposals. */
  private readonly opaqueMaterial = new THREE.MeshBasicMaterial({ vertexColors: true });
  private readonly clearMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.72,
    depthWrite: false
  });

  private centreCX = 0;
  private centreCZ = 0;
  private planned = false;
  private pumping = false;
  private disposed = false;

  private faces = 0;
  private vertexBytes = 0;
  private pending = 0;

  private radius: number;

  constructor(
    private readonly scene: THREE.Scene,
    dimension: DimensionRef,
    private readonly options: StreamerOptions = {}
  ) {
    this.radius = options.radius ?? 12;
    this.regions = new RegionCache(dimension);
    this.scene.add(this.group);
  }

  /** Render distance in chunks. Changing it replans on the next frame. */
  setRadius(chunks: number) {
    if (chunks === this.radius) return;
    this.radius = chunks;
    this.planned = false;
    this.ringCache.clear();
    this.kick();
  }

  get renderDistance(): number {
    return this.radius;
  }

  /**
   * Tell the streamer where the camera is. Cheap enough to call every frame —
   * it only does anything when the camera crosses a chunk boundary.
   */
  update(position: THREE.Vector3) {
    const cx = Math.floor(position.x / 16);
    const cz = Math.floor(position.z / 16);
    if (cx === this.centreCX && cz === this.centreCZ && this.planned) return;
    this.centreCX = cx;
    this.centreCZ = cz;
    this.planned = false;
    this.kick();
  }

  dispose() {
    this.disposed = true;
    for (const key of [...this.tiles.keys()]) this.dropTile(key);
    this.scene.remove(this.group);
    this.opaqueMaterial.dispose();
    this.clearMaterial.dispose();
    this.store.clear();
    this.regions.clear();
  }

  /* ------------------------------------------------------------- planning */

  private kick() {
    if (!this.pumping && !this.disposed) void this.pump();
  }

  /**
   * Chunks inside a radius, nearest first.
   *
   * Memoised on centre and radius: the pump asks for this twice per frame and
   * at a render distance of 24 that is two sorts of ~1800 entries for a list
   * that only changes when the camera crosses a chunk boundary.
   */
  private ringCache = new Map<number, Ring>();
  private ringCentre = NaN;

  private ring(radius: number): Ring {
    if (this.ringCentre !== chunkKey(this.centreCX, this.centreCZ)) {
      this.ringCache.clear();
      this.ringCentre = chunkKey(this.centreCX, this.centreCZ);
    }
    const hit = this.ringCache.get(radius);
    if (hit) return hit;
    const built = this.buildRing(radius);
    this.ringCache.set(radius, built);
    return built;
  }

  private buildRing(radius: number): Ring {
    const out: Ring = [];
    const r2 = radius * radius;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const d = dx * dx + dz * dz;
        if (d > r2) continue;
        const cx = this.centreCX + dx;
        const cz = this.centreCZ + dz;
        out.push({ cx, cz, key: chunkKey(cx, cz), d });
      }
    }
    out.sort((a, b) => a.d - b.d);
    return out;
  }

  /** Squared chunk distance from the current centre. */
  private distance(cx: number, cz: number): number {
    const dx = cx - this.centreCX;
    const dz = cz - this.centreCZ;
    return dx * dx + dz * dz;
  }

  /* ------------------------------------------------------------ the pump */

  private async pump() {
    this.pumping = true;
    try {
      while (!this.disposed) {
        this.planned = true;
        this.evict();
        const did = await this.step();
        this.emit(did);
        if (!did) break;
        await nextFrame();
      }
    } catch (e) {
      this.options.onError?.(e instanceof Error ? e.message : String(e));
    } finally {
      this.pumping = false;
    }
  }

  /**
   * One slice of work: fill in missing data if any is missing, otherwise build
   * geometry. Returns false when everything in range is drawn.
   */
  private async step(): Promise<boolean> {
    if (await this.loadStep()) return true;
    return this.meshStep();
  }

  /** Fetch the region holding the nearest unresolved chunk, and parse every
   *  wanted chunk it contains — one fetch should serve many chunks. */
  private async loadStep(): Promise<boolean> {
    const wanted = this.ring(this.radius + DATA_MARGIN);
    this.pending = 0;

    let target: { cx: number; cz: number } | null = null;
    for (const c of wanted) {
      if (this.store.resolved(c.cx, c.cz)) continue;
      this.pending++;
      if (!target) target = c;
    }
    if (!target) return false;

    const ref = this.regions.regionFor(target.cx, target.cz);
    if (!ref) {
      /* No region file covers this chunk: the world simply stops here. Mark the
         whole region's worth absent so the scan does not revisit it. */
      this.markRegionAbsent(target.cx, target.cz);
      return true;
    }

    const existing = await this.regions.chunkKeys(ref);
    if (this.disposed) return false;
    if (!existing) {
      this.markRegionAbsent(target.cx, target.cz);
      return true;
    }

    /* Everything wanted from this region, so one fetch covers many chunks. */
    const rx = Math.floor(target.cx / CHUNKS_PER_AXIS);
    const rz = Math.floor(target.cz / CHUNKS_PER_AXIS);
    const group = wanted.filter(
      (c) =>
        !this.store.resolved(c.cx, c.cz) &&
        Math.floor(c.cx / CHUNKS_PER_AXIS) === rx &&
        Math.floor(c.cz / CHUNKS_PER_AXIS) === rz
    );

    /* Chunks the header says are not there cost nothing and unblock their
       neighbours immediately, so resolve them before touching the body. */
    const present = group.filter((c) => {
      if (existing.has(c.key)) return true;
      this.store.markAbsent(c.cx, c.cz);
      return false;
    });
    if (present.length === 0) return true;

    const file = await this.regions.file(ref);
    if (this.disposed) return false;
    if (!file) {
      for (const c of group) this.store.markAbsent(c.cx, c.cz);
      return true;
    }

    const deadline = performance.now() + STEP_BUDGET_MS;
    for (const c of present) {
      try {
        const nbt = await file.readChunk(c.cx - rx * CHUNKS_PER_AXIS, c.cz - rz * CHUNKS_PER_AXIS);
        if (!nbt) {
          this.store.markAbsent(c.cx, c.cz);
        } else {
          const chunk = parseChunk(nbt);
          if (isRenderable(chunk)) this.store.add(chunk);
          else this.store.markAbsent(c.cx, c.cz);
        }
      } catch (e) {
        /* One bad chunk must not stall the region: record it as absent so the
           pump moves on, and surface the first message. */
        this.store.markAbsent(c.cx, c.cz);
        this.options.onError?.(e instanceof Error ? e.message : String(e));
      }
      if (performance.now() > deadline) break;
    }
    return true;
  }

  private markRegionAbsent(cx: number, cz: number) {
    const rx = Math.floor(cx / CHUNKS_PER_AXIS) * CHUNKS_PER_AXIS;
    const rz = Math.floor(cz / CHUNKS_PER_AXIS) * CHUNKS_PER_AXIS;
    for (let z = 0; z < CHUNKS_PER_AXIS; z++) {
      for (let x = 0; x < CHUNKS_PER_AXIS; x++) this.store.markAbsent(rx + x, rz + z);
    }
  }

  /** Build geometry for whatever is ready, until the frame budget runs out. */
  private meshStep(): boolean {
    const deadline = performance.now() + STEP_BUDGET_MS;
    let did = false;

    for (const c of this.ring(this.radius)) {
      if (this.tiles.has(c.key)) continue;
      const chunk = this.store.get(c.cx, c.cz);
      if (!chunk) continue;

      /* Only the four side neighbours are read by the mesher's border fill;
         corners of the padded volume are never sampled. */
      if (
        !this.store.resolved(c.cx + 1, c.cz) ||
        !this.store.resolved(c.cx - 1, c.cz) ||
        !this.store.resolved(c.cx, c.cz + 1) ||
        !this.store.resolved(c.cx, c.cz - 1)
      ) {
        continue;
      }

      this.buildTile(c.key, chunk);
      did = true;
      if (performance.now() > deadline) break;
    }
    return did;
  }

  private buildTile(key: number, chunk: ParsedChunk) {
    const result = meshWorld(this.store.sourceFor(chunk));
    const meshes: THREE.Mesh[] = [];
    let bytes = 0;

    for (const [buffers, opaque] of [
      [result.opaque, true],
      [result.translucent, false]
    ] as Array<[FaceBuffers | null, boolean]>) {
      if (!buffers) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Int16BufferAttribute(buffers.positions, 3));
      geometry.setAttribute('color', new THREE.Uint8BufferAttribute(buffers.colors, 3, true));
      geometry.computeBoundingSphere();

      const mesh = new THREE.Mesh(geometry, opaque ? this.opaqueMaterial : this.clearMaterial);
      mesh.renderOrder = opaque ? 0 : 1;
      meshes.push(mesh);
      this.group.add(mesh);
      bytes += buffers.positions.byteLength + buffers.colors.byteLength;
    }

    this.tiles.set(key, { meshes, faces: result.faces, bytes });
    this.faces += result.faces;
    this.vertexBytes += bytes;
  }

  /* ----------------------------------------------------------- eviction */

  private evict() {
    const meshLimit = (this.radius + EVICT_MARGIN) ** 2;
    const dataLimit = (this.radius + DATA_MARGIN + EVICT_MARGIN) ** 2;

    for (const [key, tile] of this.tiles) {
      const { cx, cz } = unkey(key);
      if (this.distance(cx, cz) <= meshLimit) continue;
      this.dropTileEntry(key, tile);
    }

    for (const key of [...this.store.keys()]) {
      const { cx, cz } = unkey(key);
      /* Chunk data outlives its geometry by design: a tile that has been
         dropped is cheap to rebuild while the blocks are still in memory. */
      if (this.distance(cx, cz) <= dataLimit) continue;
      if (this.tiles.has(key)) continue;
      this.store.drop(cx, cz);
    }
  }

  private dropTile(key: number) {
    const tile = this.tiles.get(key);
    if (tile) this.dropTileEntry(key, tile);
  }

  private dropTileEntry(key: number, tile: Tile) {
    for (const mesh of tile.meshes) {
      this.group.remove(mesh);
      /* Materials are shared, so only the geometry is this tile's to free.
         three.js does not release GPU buffers on garbage collection. */
      mesh.geometry.dispose();
    }
    this.faces -= tile.faces;
    this.vertexBytes -= tile.bytes;
    this.tiles.delete(key);
  }

  /* --------------------------------------------------------------- stats */

  private emit(working: boolean) {
    this.options.onStats?.({
      loaded: this.store.size,
      meshed: this.tiles.size,
      pending: this.pending,
      faces: this.faces,
      vertexBytes: this.vertexBytes,
      regionsFetched: this.regions.regionsFetched,
      bytesFetched: this.regions.bytesFetched,
      regionsHeld: this.regions.bodiesHeld,
      bytesHeld: this.regions.bytesHeld,
      working
    });
  }
}

/** Inverse of `chunkKey`, sign-extending both halves back to signed chunks. */
function unkey(key: number): { cx: number; cz: number } {
  const hi = Math.floor(key / 0x1000000);
  const lo = key - hi * 0x1000000;
  const sign = (v: number) => (v >= 0x800000 ? v - 0x1000000 : v);
  return { cx: sign(hi), cz: sign(lo) };
}
