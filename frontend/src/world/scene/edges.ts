/**
 * Connections as line segments between marker centres.
 *
 * Drawn with depth testing off, unlike the markers: a connection is a claim
 * about the graph rather than a thing in the world, and the whole use of seeing
 * one in 3D is following it through the geometry it passes behind. Ephemeral
 * connections get the dashed pass, matching the 2D canvas.
 *
 * Only connections with both ends placed are drawn — an edge to a location with
 * no coordinates has nowhere to end.
 */

import * as THREE from 'three';

export interface EdgeDatum {
  id: string;
  color: string;
  dashed: boolean;
  /** Ids of the two ends, so a filter can tell whether both are on screen. */
  sourceId: string;
  targetId: string;
  /** Block coordinates of each end. */
  a: { x: number; y: number; z: number };
  b: { x: number; y: number; z: number };
}

/** Segments are allocated in blocks of this, so small edits never reallocate. */
const GRANULARITY = 64;

const DASH_SIZE = 1.4;
const GAP_SIZE = 0.9;

interface Pass {
  object: THREE.LineSegments;
  geometry: THREE.BufferGeometry;
  positions: THREE.BufferAttribute;
  colors: THREE.BufferAttribute;
  capacity: number;
}

export class EdgeLayer {
  readonly group = new THREE.Group();

  private readonly solidMaterial = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.8,
    depthTest: false
  });
  private readonly dashedMaterial = new THREE.LineDashedMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.8,
    depthTest: false,
    dashSize: DASH_SIZE,
    gapSize: GAP_SIZE
  });

  private solid: Pass | null = null;
  private dashed: Pass | null = null;
  private readonly colour = new THREE.Color();

  private data: EdgeDatum[] = [];
  private visibleIds: Set<string> | null = null;

  constructor() {
    this.group.name = 'connections';
  }

  setData(edges: EdgeDatum[]) {
    this.data = edges;
    this.refill();
  }

  /**
   * Draw only connections with both ends among these locations, or all of them
   * with null. Both ends, because a line to a marker that is not being drawn
   * points at nothing and reads as a wrong edge rather than a hidden one.
   */
  setVisible(ids: Set<string> | null) {
    this.visibleIds = ids;
    this.refill();
  }

  private refill() {
    const shown = this.visibleIds
      ? this.data.filter((e) => this.visibleIds!.has(e.sourceId) && this.visibleIds!.has(e.targetId))
      : this.data;
    this.fill(
      'solid',
      shown.filter((e) => !e.dashed)
    );
    this.fill(
      'dashed',
      shown.filter((e) => e.dashed)
    );
  }

  dispose() {
    for (const pass of [this.solid, this.dashed]) {
      if (!pass) continue;
      this.group.remove(pass.object);
      pass.geometry.dispose();
    }
    this.solid = null;
    this.dashed = null;
    this.solidMaterial.dispose();
    this.dashedMaterial.dispose();
  }

  /* ------------------------------------------------------------ internals */

  private fill(which: 'solid' | 'dashed', edges: EdgeDatum[]) {
    let pass = which === 'solid' ? this.solid : this.dashed;

    if (!pass || edges.length > pass.capacity) {
      if (pass) {
        this.group.remove(pass.object);
        pass.geometry.dispose();
      }
      pass = this.allocate(which, Math.ceil(Math.max(edges.length, 1) / GRANULARITY) * GRANULARITY);
      if (which === 'solid') this.solid = pass;
      else this.dashed = pass;
    }

    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const v = i * 2;
      pass.positions.setXYZ(v, e.a.x + 0.5, e.a.y + 0.5, e.a.z + 0.5);
      pass.positions.setXYZ(v + 1, e.b.x + 0.5, e.b.y + 0.5, e.b.z + 0.5);
      try {
        this.colour.setStyle(e.color || '#8aa2c0');
      } catch {
        this.colour.set(0x8aa2c0);
      }
      pass.colors.setXYZ(v, this.colour.r, this.colour.g, this.colour.b);
      pass.colors.setXYZ(v + 1, this.colour.r, this.colour.g, this.colour.b);
    }

    pass.positions.needsUpdate = true;
    pass.colors.needsUpdate = true;
    pass.geometry.setDrawRange(0, edges.length * 2);
    pass.object.visible = edges.length > 0;

    /* Dash phase is baked into an attribute, so it has to be recomputed
       whenever an endpoint moves — otherwise a dragged connection keeps the
       dash spacing of its old length. */
    if (which === 'dashed' && edges.length) pass.object.computeLineDistances();
  }

  private allocate(which: 'solid' | 'dashed', capacity: number): Pass {
    const geometry = new THREE.BufferGeometry();
    const positions = new THREE.BufferAttribute(new Float32Array(capacity * 6), 3);
    const colors = new THREE.BufferAttribute(new Float32Array(capacity * 6), 3);
    positions.setUsage(THREE.DynamicDrawUsage);
    colors.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', positions);
    geometry.setAttribute('color', colors);

    const object = new THREE.LineSegments(
      geometry,
      which === 'solid' ? this.solidMaterial : this.dashedMaterial
    );
    /* The unused tail of the buffer sits at the origin, which would drag the
       bounding sphere out to include it. Nothing here is expensive enough to
       be worth culling. */
    object.frustumCulled = false;
    object.renderOrder = 8;
    this.group.add(object);

    return { object, geometry, positions, colors, capacity };
  }
}
