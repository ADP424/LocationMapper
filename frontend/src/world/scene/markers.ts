/**
 * Location markers: one instanced octahedron per placed location.
 *
 * Two meshes are drawn for every marker, at the same place. The solid one is
 * depth-tested like ordinary geometry; the ghost is drawn last with depth
 * testing off, so a marker inside a wall still shows faintly through it. That
 * matters more here than it sounds: the worlds this is for are interiors, and a
 * waypoint you cannot see until you are already in the room with it is not
 * doing the one job it has.
 *
 * Both meshes share a geometry and a per-instance colour buffer, so the cost of
 * the second one is a draw call.
 */

import * as THREE from 'three';

export interface MarkerDatum {
  id: string;
  /** Any CSS colour; unparseable values fall back to white. */
  color: string;
  /**
   * Draw a cage around this marker in the given colour — how a planned trip
   * calls out its start, its end and the stops in between. Undefined for the
   * ordinary case, which is most markers most of the time.
   */
  ring?: string;
  /**
   * Exempt from the distance cull.
   *
   * Set for the stops of a planned route: the route is the whole subject of the
   * picture when one is up, and a path that fades out halfway along is worse
   * than no path at all.
   */
  pinned?: boolean;
  /** Block coordinates. The marker is centred in the block. */
  x: number;
  y: number;
  z: number;
}

/** Radius in blocks. Slightly under one so a marker sits inside its block. */
const SIZE = 0.85;

/** Instances are allocated in blocks of this, so small edits never reallocate. */
const GRANULARITY = 64;

const HIGHLIGHT_COLOR = 0xffd166;

export class MarkerLayer {
  readonly group = new THREE.Group();

  private readonly geometry = new THREE.OctahedronGeometry(SIZE);
  private readonly solidMaterial = new THREE.MeshBasicMaterial({ vertexColors: false });
  private readonly ghostMaterial = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.25,
    depthTest: false,
    depthWrite: false
  });

  /* Route rings are their own instanced pass rather than a colour change on
     the marker, so a waypoint keeps the colour it has everywhere else in the
     app and only gains a cage around it. */
  private readonly ringGeometry = new THREE.OctahedronGeometry(SIZE * 1.7);
  private readonly ringMaterial = new THREE.MeshBasicMaterial({
    wireframe: true,
    transparent: true,
    opacity: 0.9,
    depthTest: false
  });

  private solid: THREE.InstancedMesh | null = null;
  private ghost: THREE.InstancedMesh | null = null;
  private rings: THREE.InstancedMesh | null = null;
  private capacity = 0;

  private data: MarkerDatum[] = [];
  private readonly indexOf = new Map<string, number>();

  /**
   * Which markers are drawn, as indices into `data`.
   *
   * Instances are packed to the front of the buffer, so hiding most of a large
   * map costs a draw of only what is left rather than a draw of everything with
   * the rest scaled to nothing. `data` keeps the full set either way — a hidden
   * marker still has a position, which is what lets the gizmo and "jump to
   * this" keep working on something you cannot currently see.
   */
  private slots: number[] = [];
  private visibleIds: Set<string> | null = null;

  private readonly highlight: THREE.LineSegments;
  private selected: string | null = null;

  private readonly matrix = new THREE.Matrix4();
  private readonly colour = new THREE.Color();

  constructor() {
    this.group.name = 'markers';

    const wire = new THREE.WireframeGeometry(new THREE.OctahedronGeometry(SIZE * 1.5));
    this.highlight = new THREE.LineSegments(
      wire,
      new THREE.LineBasicMaterial({ color: HIGHLIGHT_COLOR, depthTest: false, transparent: true })
    );
    this.highlight.renderOrder = 12;
    this.highlight.visible = false;
    this.group.add(this.highlight);
  }

  /** Replace the marker set. Reuses the existing buffers when they still fit. */
  setData(next: MarkerDatum[]) {
    this.data = next;
    this.indexOf.clear();
    for (let i = 0; i < next.length; i++) this.indexOf.set(next[i].id, i);

    if (next.length > this.capacity) this.allocate(Math.ceil(next.length / GRANULARITY) * GRANULARITY);
    this.repack();
  }

  /**
   * Draw only these markers, or all of them with null.
   *
   * The selected marker is always kept: hiding the thing the inspector is
   * describing, and the gizmo is attached to, would be actively confusing.
   */
  setVisible(ids: Set<string> | null) {
    this.visibleIds = ids;
    this.repack();
  }

  private repack() {
    if (!this.solid || !this.ghost || !this.rings) return;

    this.slots.length = 0;
    for (let i = 0; i < this.data.length; i++) {
      const m = this.data[i];
      if (!this.visibleIds || this.visibleIds.has(m.id) || m.id === this.selected) {
        this.slots.push(i);
      }
    }

    let ringCount = 0;
    for (let slot = 0; slot < this.slots.length; slot++) {
      const m = this.data[this.slots[slot]];
      this.matrix.makeTranslation(m.x + 0.5, m.y + 0.5, m.z + 0.5);
      this.solid.setMatrixAt(slot, this.matrix);
      this.ghost.setMatrixAt(slot, this.matrix);
      this.readColour(m.color);
      this.solid.setColorAt(slot, this.colour);
      this.ghost.setColorAt(slot, this.colour);

      /* Rings are packed to the front of their own buffer, so the draw covers
         only the markers that actually have one. */
      if (m.ring) {
        this.rings.setMatrixAt(ringCount, this.matrix);
        this.readColour(m.ring);
        this.rings.setColorAt(ringCount, this.colour);
        ringCount++;
      }
    }

    this.solid.count = this.slots.length;
    this.ghost.count = this.slots.length;
    this.rings.count = ringCount;
    this.solid.instanceMatrix.needsUpdate = true;
    this.ghost.instanceMatrix.needsUpdate = true;
    this.rings.instanceMatrix.needsUpdate = true;
    if (this.solid.instanceColor) this.solid.instanceColor.needsUpdate = true;
    if (this.ghost.instanceColor) this.ghost.instanceColor.needsUpdate = true;
    if (this.rings.instanceColor) this.rings.instanceColor.needsUpdate = true;

    /* Instanced bounds do not follow the matrices on their own, and a stale
       sphere gets the whole layer frustum-culled from the wrong place. */
    this.solid.computeBoundingSphere();
    this.ghost.boundingSphere = this.solid.boundingSphere;
    this.rings.boundingSphere = this.solid.boundingSphere;

    this.refreshHighlight();
  }

  setSelected(id: string | null) {
    if (this.selected === id) return;
    this.selected = id;
    /* The selection is force-shown, so changing it changes what is drawn. */
    if (this.visibleIds) this.repack();
    this.refreshHighlight();
  }

  /** Centre of a marker in world space, or null if it is not placed. */
  positionOf(id: string): THREE.Vector3 | null {
    const i = this.indexOf.get(id);
    if (i === undefined) return null;
    const m = this.data[i];
    return new THREE.Vector3(m.x + 0.5, m.y + 0.5, m.z + 0.5);
  }

  /**
   * Nearest marker along the ray, if any.
   *
   * Occlusion is not considered on purpose: a marker behind a wall is drawn by
   * the ghost pass, so it has to be clickable too, or the thing you can plainly
   * see cannot be selected.
   */
  pick(raycaster: THREE.Raycaster): { id: string; distance: number } | null {
    if (!this.solid || this.solid.count === 0) return null;
    const hit = raycaster.intersectObject(this.solid, false)[0];
    if (!hit || hit.instanceId === undefined) return null;
    /* Instances are packed, so the hit index is a slot, not a data index. */
    const datum = this.data[this.slots[hit.instanceId]];
    return datum ? { id: datum.id, distance: hit.distance } : null;
  }

  dispose() {
    this.disposeMeshes();
    this.geometry.dispose();
    this.ringGeometry.dispose();
    this.solidMaterial.dispose();
    this.ghostMaterial.dispose();
    this.ringMaterial.dispose();
    this.highlight.geometry.dispose();
    (this.highlight.material as THREE.Material).dispose();
  }

  /* ------------------------------------------------------------ internals */

  private allocate(capacity: number) {
    this.disposeMeshes();
    this.capacity = capacity;

    this.solid = new THREE.InstancedMesh(this.geometry, this.solidMaterial, capacity);
    this.ghost = new THREE.InstancedMesh(this.geometry, this.ghostMaterial, capacity);
    this.rings = new THREE.InstancedMesh(this.ringGeometry, this.ringMaterial, capacity);
    this.ghost.renderOrder = 10;
    this.rings.renderOrder = 11;

    for (const mesh of [this.solid, this.ghost, this.rings]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      this.group.add(mesh);
    }
  }

  private disposeMeshes() {
    for (const mesh of [this.solid, this.ghost, this.rings]) {
      if (!mesh) continue;
      this.group.remove(mesh);
      mesh.dispose();
    }
    this.solid = null;
    this.ghost = null;
    this.rings = null;
    this.capacity = 0;
  }

  private readColour(css: string) {
    try {
      this.colour.setStyle(css || '#ffffff');
    } catch {
      this.colour.set(0xffffff);
    }
  }

  private refreshHighlight() {
    const at = this.selected ? this.positionOf(this.selected) : null;
    this.highlight.visible = at !== null;
    if (at) this.highlight.position.copy(at);
  }
}
