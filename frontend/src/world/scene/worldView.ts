/**
 * The 3D view: a Minecraft world streamed around the camera, with the map's
 * locations and connections drawn on top of it.
 *
 * This owns everything three.js and nothing React — the component that mounts
 * it feeds it data and gets callbacks back. Keeping the boundary there means
 * the render loop never touches React state, which is the only way a canvas
 * that redraws at 144 Hz and a store that redraws on edit can share a screen.
 *
 * The world half is optional. With no world folder chosen the streamer is never
 * created and the graph floats over a reference grid, which is a perfectly
 * usable way to look at coordinates that were typed in by hand.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

import type { DimensionRef } from '../source/worldSource';
import { WorldStreamer, type StreamStats } from '../stream/streamer';
import { tourStep } from './tour';
import { EdgeLayer, type EdgeDatum } from './edges';
import { FlyControls } from './flyControls';
import { LabelLayer, type LabelDatum } from './labels';
import { MarkerLayer, type MarkerDatum } from './markers';
import { blockInFrontOf } from './pick';

const SKY = 0x8fb8de;

/** Pointer travel, in pixels, above which a click is really an orbit drag. */
const DRAG_SLOP = 4;

/**
 * How far a name stays on screen, in blocks — the starting value for a control
 * the sidebar owns.
 *
 * There is no distance that is right for every map. A few dozen rooms want
 * every name visible from anywhere; several hundred in a maze want almost none
 * of them, or the screen is a wall of overlapping text. Framing a large map
 * puts the camera further out than this, which is why the names vanish when you
 * zoom all the way out and why this had to become adjustable.
 */
const DEFAULT_LABEL_DISTANCE = 220;

/** Camera travel, in blocks, before the visible-marker set is recomputed. */
const MARKER_RECHECK = 4;

/** Camera distance used when framing a single point. */
const FOCUS_DISTANCE = 42;

/* ------------------------------------------------------------- the tour */

/** Eye height above the path, so the camera is not inside the floor. */
const TOUR_LIFT = 2.2;
/** How far along the curve the camera looks, as a fraction of the whole. */
const TOUR_LOOK_AHEAD = 0.004;

export interface GraphData {
  markers: MarkerDatum[];
  edges: EdgeDatum[];
  labels: LabelDatum[];
}

export interface WorldViewOptions {
  onStats?(stats: StreamStats | null): void;
  onError?(message: string): void;
  onFlyChange?(active: boolean): void;
  /** A marker was clicked. */
  onPickLocation?(id: string): void;
  /** A block was clicked; coordinates are of the empty block in front of it. */
  onPickBlock?(x: number, y: number, z: number): void;
  /** Nothing was under the pointer. */
  onPickNothing?(): void;
  /** The route tour started or stopped (including on reaching the end). */
  onTourChange?(touring: boolean): void;
  /** The gizmo moved the selected marker to a new block. */
  onDragCoords?(id: string, x: number, y: number, z: number): void;
}

export class WorldView {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly labelRenderer: CSS2DRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(65, 1, 0.1, 4000);
  private readonly orbit: OrbitControls;
  private readonly fly: FlyControls;
  private readonly gizmo: TransformControls;
  private readonly gizmoTarget = new THREE.Object3D();
  private readonly grid: THREE.GridHelper;
  private readonly ground: THREE.Mesh;

  private readonly markers = new MarkerLayer();
  private readonly edges = new EdgeLayer();
  private readonly labels = new LabelLayer();

  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private pressAt: { x: number; y: number } | null = null;

  private streamer: WorldStreamer | null = null;
  private dimension: DimensionRef | null = null;
  private radius = 12;

  private graph: GraphData | null = null;
  private markerDistance: number | null = null;
  private readonly markerCentre = new THREE.Vector3(NaN, NaN, NaN);

  private tour: THREE.CatmullRomCurve3 | null = null;
  private tourLength = 0;
  private tourU = 0;
  /** Weight on `TOUR_SPEED`; see `setTourSpeed`. */
  private tourSpeed = 1;
  private readonly tourAt = new THREE.Vector3();
  private readonly tourLook = new THREE.Vector3();

  private selection: string | null = null;
  private gizmoEnabled = true;
  private dragging = false;
  private labelsVisible = true;
  private labelDistance = DEFAULT_LABEL_DISTANCE;
  private lastFrame = performance.now();
  private disposed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    labelHost: HTMLElement,
    private readonly options: WorldViewOptions = {}
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

    this.labelRenderer = new CSS2DRenderer({ element: labelHost });

    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, 260, 900);
    /* No lights anywhere: the mesher bakes its per-face tint into vertex
       colours, and every overlay material is unlit by design. */

    this.camera.position.set(48, 90, 48);

    this.orbit = new OrbitControls(this.camera, canvas);
    this.orbit.enableDamping = true;

    this.fly = new FlyControls(this.camera, canvas, {
      onActiveChange: (active) => {
        this.orbit.enabled = !active;
        this.applyGizmo();
        if (!active) {
          /* Hand the orbit camera something in front of where the fly camera
             was left, or the view snaps back to the last orbit target. */
          const ahead = new THREE.Vector3();
          this.camera.getWorldDirection(ahead);
          this.orbit.target.copy(this.camera.position).addScaledVector(ahead, 24);
          this.orbit.update();
        }
        this.options.onFlyChange?.(active);
      }
    });

    this.gizmo = new TransformControls(this.camera, canvas);
    this.gizmo.setMode('translate');
    /* Snapped to whole blocks: coordinates are integers in the database, and a
       gizmo that slides continuously would round on release and appear to
       jump. */
    this.gizmo.translationSnap = 1;
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.dragging = Boolean((e as unknown as { value: boolean }).value);
      this.orbit.enabled = !this.dragging && !this.fly.active;
      /* On release, snap the handle back onto whatever the store actually
         settled on — the value written may have been clamped or rounded, and
         a gizmo half a block off its marker is a lie about where the thing
         is. */
      if (!this.dragging) this.applyGizmo();
    });
    this.gizmo.addEventListener('objectChange', () => {
      if (!this.selection) return;
      const p = this.gizmoTarget.position;
      this.options.onDragCoords?.(
        this.selection,
        Math.floor(p.x),
        Math.floor(p.y),
        Math.floor(p.z)
      );
    });
    this.scene.add(this.gizmo.getHelper());
    this.scene.add(this.gizmoTarget);

    /* Stand-in for the world when no folder is open: somewhere for the graph
       to sit, and — via the plane under it — something for "click here to
       place a location" to hit. A GridHelper alone is line geometry, which
       raycasts by threshold and would make placement a game of darts. */
    this.grid = new THREE.GridHelper(1024, 64, 0x51637a, 0x33404f);
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.5;
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1024, 1024),
      new THREE.MeshBasicMaterial({ color: 0x1b2430, transparent: true, opacity: 0.55 })
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.01; // just under the grid, so the lines still read
    this.scene.add(this.grid, this.ground);

    this.scene.add(this.markers.group, this.edges.group, this.labels.group);

    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('dblclick', this.onDoubleClick);

    this.renderer.setAnimationLoop(this.frame);
  }

  /* --------------------------------------------------------------- world */

  /** Bind the streamer to a dimension, or drop it entirely with null. */
  setDimension(dimension: DimensionRef | null) {
    if (dimension === this.dimension) return;
    this.dimension = dimension;

    this.streamer?.dispose();
    this.streamer = null;
    this.options.onStats?.(null);

    this.grid.visible = !dimension;
    this.ground.visible = !dimension;

    if (!dimension) {
      this.scene.fog = new THREE.Fog(SKY, 600, 2400);
      return;
    }

    this.streamer = new WorldStreamer(this.scene, dimension, {
      radius: this.radius,
      onStats: (stats) => this.options.onStats?.(stats),
      onError: (message) => this.options.onError?.(message)
    });
    this.applyFog();
  }

  setRenderDistance(chunks: number) {
    if (chunks === this.radius) return;
    this.radius = chunks;
    this.streamer?.setRadius(chunks);
    if (this.streamer) this.applyFog();
  }

  /* --------------------------------------------------------------- graph */

  setGraph(data: GraphData) {
    this.graph = data;
    this.markers.setData(data.markers);
    this.edges.setData(data.edges);
    this.labels.setData(data.labels);
    this.applyVisibility(true);
    this.applyGizmo();
  }

  /**
   * Draw only markers within this many blocks of the camera, or all of them
   * with null.
   *
   * The counterpart of the label distance, and the same idea: past some range
   * a marker is a speck that only adds to the clutter. It composes with the
   * mode rather than replacing it — "on the route, and near me" is a reasonable
   * thing to ask for.
   *
   * The other ways of thinning the map out are decided once per edit in
   * `buildGraphData`. This one cannot be: it changes as the camera moves, so it
   * is recomputed here, and only when the camera has actually gone somewhere.
   */
  setMarkerDistance(blocks: number | null) {
    if (blocks === this.markerDistance) return;
    this.markerDistance = blocks;
    this.applyVisibility(true);
  }

  setSelection(id: string | null) {
    this.selection = id;
    this.markers.setSelected(id);
    this.labels.setSelected(id);
    this.applyGizmo();
  }

  /** Whether the drag gizmo may attach at all. */
  setGizmoEnabled(enabled: boolean) {
    this.gizmoEnabled = enabled;
    this.applyGizmo();
  }

  setLabelsVisible(visible: boolean) {
    this.labelsVisible = visible;
  }

  /** How far a name stays on screen, in blocks. */
  setLabelDistance(blocks: number) {
    this.labelDistance = blocks;
  }

  /* ---------------------------------------------------------- navigation */

  /** Put the camera near a point and look at it. */
  focusOn(x: number, y: number, z: number) {
    this.orbit.target.set(x, y, z);
    if (!this.fly.active) {
      const offset = new THREE.Vector3(0.6, 0.55, 0.6)
        .normalize()
        .multiplyScalar(FOCUS_DISTANCE);
      this.camera.position.copy(this.orbit.target).add(offset);
    }
    this.orbit.update();
    this.streamer?.update(this.orbit.target);
  }

  /** Stand at a point, looking at the horizon. Used for spawn and jumps. */
  goTo(x: number, y: number, z: number) {
    this.camera.position.set(x, y + 2, z);
    this.orbit.target.set(x + 32, y + 2, z);
    this.orbit.update();
    this.streamer?.update(this.camera.position);
  }

  /** Frame one location. False if it has no coordinates. */
  focusLocation(id: string): boolean {
    const at = this.markers.positionOf(id);
    if (!at) return false;
    this.focusOn(at.x, at.y, at.z);
    return true;
  }

  /**
   * Frame a subset of the map — the planned route, in practice.
   *
   * Ids that are not placed are skipped rather than refused: a route through
   * one room with no coordinates is still worth framing around the rest.
   */
  fitToLocations(ids: string[]): boolean {
    const placed: MarkerDatum[] = [];
    for (const id of ids) {
      const at = this.markers.positionOf(id);
      if (at) placed.push({ id, color: '', x: at.x - 0.5, y: at.y - 0.5, z: at.z - 0.5 });
    }
    return this.frameGraph(placed);
  }

  /** Frame every marker at once. No-op when nothing is placed. */
  frameGraph(markers: MarkerDatum[]): boolean {
    if (!markers.length) return false;

    const box = new THREE.Box3();
    const point = new THREE.Vector3();
    for (const m of markers) box.expandByPoint(point.set(m.x + 0.5, m.y + 0.5, m.z + 0.5));

    const centre = box.getCenter(new THREE.Vector3());
    /* Backed off past the bounding sphere rather than sitting on it, so the
       outermost markers land inside the frame and not on its edge. */
    const span = Math.max(box.getSize(new THREE.Vector3()).length(), 24) * 1.25;

    this.orbit.target.copy(centre);
    this.camera.position
      .copy(centre)
      .add(new THREE.Vector3(0.6, 0.5, 0.6).normalize().multiplyScalar(span));
    this.orbit.update();
    this.streamer?.update(this.orbit.target);
    return true;
  }

  /**
   * Fly the camera along a route, start to end, in one continuous move.
   *
   * The stops are the control points of a Catmull-Rom curve rather than a
   * polyline, so the camera banks through corners instead of snapping at every
   * room, and `getPointAt` walks it by arc length, so the speed is the same in
   * a dense cluster of rooms as it is across a long corridor.
   *
   * Returns false when there is not enough of a route to fly along.
   */
  startTour(points: Array<{ x: number; y: number; z: number }>): boolean {
    /* A route that doubles back through a room it already visited repeats a
       point; a zero-length segment makes the curve's tangent undefined and the
       camera spin on the spot. */
    const path: THREE.Vector3[] = [];
    for (const p of points) {
      const v = new THREE.Vector3(p.x + 0.5, p.y + 0.5, p.z + 0.5);
      if (!path.length || path[path.length - 1].distanceToSquared(v) > 1e-6) path.push(v);
    }
    if (path.length < 2) return false;

    this.stopTour(false);
    this.tour = new THREE.CatmullRomCurve3(path, false, 'catmullrom', 0.5);
    this.tourLength = Math.max(this.tour.getLength(), 1);
    this.tourU = 0;

    /* The tour owns the camera while it runs. */
    this.fly.exit();
    this.orbit.enabled = false;
    this.applyGizmo();
    this.options.onTourChange?.(true);
    return true;
  }

  /**
   * Weight the tour's cruise speed. 1 is the built-in speed.
   *
   * Applied per frame rather than baked in at the start, so dragging the slider
   * mid-tour changes the speed under way instead of on the next run.
   */
  setTourSpeed(weight: number) {
    this.tourSpeed = Number.isFinite(weight) && weight > 0 ? weight : 1;
  }

  stopTour(notify = true) {
    if (!this.tour) return;
    this.tour = null;
    this.orbit.enabled = !this.fly.active;
    /* Leave the orbit target where the camera ended up looking, or the view
       jumps back to wherever it was before the tour started. */
    const ahead = new THREE.Vector3();
    this.camera.getWorldDirection(ahead);
    this.orbit.target.copy(this.camera.position).addScaledVector(ahead, 24);
    this.orbit.update();
    this.applyGizmo();
    if (notify) this.options.onTourChange?.(false);
  }

  get touring(): boolean {
    return this.tour !== null;
  }

  enterFly() {
    /* Taking the controls ends the tour — two things steering one camera is
       not a thing that can be resolved sensibly. */
    this.stopTour();
    this.fly.enter();
  }

  exitFly() {
    this.fly.exit();
  }

  get flying(): boolean {
    return this.fly.active;
  }

  setFlySpeed(scale: number) {
    this.fly.speedScale = scale;
  }

  dispose() {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('dblclick', this.onDoubleClick);

    this.streamer?.dispose();
    this.fly.dispose();
    this.orbit.dispose();
    this.disposeGizmo();
    this.markers.dispose();
    this.edges.dispose();
    this.labels.dispose();
    this.grid.geometry.dispose();
    (this.grid.material as THREE.Material).dispose();
    this.ground.geometry.dispose();
    (this.ground.material as THREE.Material).dispose();
    this.renderer.dispose();
  }

  /**
   * Free the gizmo by hand.
   *
   * `TransformControls.dispose()` is broken in three 0.169: it calls
   * `this.traverse(...)`, but as of that release the class extends `Controls`,
   * which descends from `EventDispatcher` and has no such method. Calling it
   * throws, which would abort the rest of teardown — including the renderer —
   * every time the view unmounts. The gizmo builds its own geometries and
   * materials per instance, so they do have to be released; the helper root is
   * where they actually live, and traversing that is what the fixed version of
   * `dispose` does.
   */
  private disposeGizmo() {
    this.gizmo.detach();
    this.gizmo.disconnect();

    const helper = this.gizmo.getHelper();
    helper.traverse((child) => {
      const withParts = child as Partial<THREE.Mesh>;
      withParts.geometry?.dispose();
      const material = withParts.material;
      if (Array.isArray(material)) for (const m of material) m.dispose();
      else material?.dispose();
    });
    this.scene.remove(helper);
  }

  /* ------------------------------------------------------------- picking */

  private readonly onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || this.dragging) return;
    /* Touching the canvas takes the camera back — a tour you cannot escape by
       grabbing the view is a trap. */
    this.stopTour();
    this.pressAt = { x: e.clientX, y: e.clientY };
  };

  private readonly onPointerUp = (e: PointerEvent) => {
    const press = this.pressAt;
    this.pressAt = null;
    if (e.button !== 0 || !press || this.dragging) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > DRAG_SLOP) return;

    if (this.fly.active) {
      /* Pointer-locked: the crosshair is the pointer. */
      this.pointer.set(0, 0);
    } else {
      const rect = this.canvas.getBoundingClientRect();
      this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    }
    this.raycaster.setFromCamera(this.pointer, this.camera);

    /* Markers win over terrain even when they are further away — the ghost
       pass draws them through walls, so they have to be clickable through
       walls too. */
    const marker = this.markers.pick(this.raycaster);
    if (marker) {
      this.options.onPickLocation?.(marker.id);
      return;
    }

    const block = this.pickBlock();
    if (block) this.options.onPickBlock?.(block.x, block.y, block.z);
    else this.options.onPickNothing?.();
  };

  /**
   * Double-click flies the orbit camera to whatever is under the pointer.
   *
   * The world is far too big to reach by dragging, and this is the cheap half
   * of getting anywhere — the other half is the fly camera.
   */
  private readonly onDoubleClick = (e: MouseEvent) => {
    if (this.fly.active || this.dragging) return;

    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const marker = this.markers.pick(this.raycaster);
    if (marker) {
      const at = this.markers.positionOf(marker.id);
      if (at) this.focusOn(at.x, at.y, at.z);
      return;
    }

    const block = this.pickBlock();
    if (block) this.focusOn(block.x + 0.5, block.y + 0.5, block.z + 0.5);
  };

  /**
   * The empty block in front of the surface under the pointer.
   *
   * Derived by stepping a hair back along the ray rather than from the face
   * normal, because the streamed geometry carries no normal attribute — and
   * this is what "place it where I am looking" means anyway: the air the ray
   * passed through last, not the solid it stopped in.
   */
  private pickBlock(): { x: number; y: number; z: number } | null {
    const targets: THREE.Object3D[] = this.streamer
      ? [this.streamer.object]
      : this.ground.visible
        ? [this.ground]
        : [];
    if (!targets.length) return null;

    const hit = this.raycaster.intersectObjects(targets, true)[0];
    if (!hit) return null;

    const block = blockInFrontOf(hit.point, this.raycaster.ray.direction);
    /* The stand-in ground has no thickness, so stepping back along the ray
       lands just above it; a location dropped there belongs at y = 0. */
    if (hit.object === this.ground) block.y = 0;
    return block;
  }

  /* ---------------------------------------------------------- the frame */

  private readonly frame = () => {
    if (this.disposed) return;

    const now = performance.now();
    /* Clamped: a backgrounded tab resumes with a multi-second gap, and an
       unclamped dt would fling the camera across the world. */
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    this.resize();
    if (this.tour) this.advanceTour(dt);
    else if (this.fly.active) this.fly.update(dt);
    else this.orbit.update();

    /* Orbiting loads around what you are looking at; flying — or touring —
       loads around you. */
    this.streamer?.update(
      this.fly.active || this.tour ? this.camera.position : this.orbit.target
    );

    this.applyVisibility();
    this.labels.cull(this.camera, this.labelsVisible ? this.labelDistance : 0);

    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  };

  /**
   * Move the camera one frame along the tour.
   *
   * Progress is in arc length, so `dt * speed / length` is genuinely constant
   * ground speed, ramped down at both ends so the tour pulls away and settles
   * rather than starting and stopping at full tilt.
   *
   * The user's weight scales the cruise speed, not the ramp: at 200% every
   * instant of the tour is twice as fast, including the ends, so the shape of
   * the ease is the same journey played faster rather than a different one.
   */
  private advanceTour(dt: number) {
    if (!this.tour) return;

    this.tourU += tourStep(this.tourU, dt, this.tourLength, this.tourSpeed);

    if (this.tourU >= 1) {
      /* Land on the final stop before handing the camera back, so the tour
         ends looking at its destination rather than just short of it. */
      this.tour.getPointAt(1, this.tourAt);
      this.camera.position.set(this.tourAt.x, this.tourAt.y + TOUR_LIFT, this.tourAt.z);
      this.stopTour();
      return;
    }

    this.tour.getPointAt(this.tourU, this.tourAt);
    this.tour.getPointAt(Math.min(1, this.tourU + TOUR_LOOK_AHEAD), this.tourLook);
    this.camera.position.set(this.tourAt.x, this.tourAt.y + TOUR_LIFT, this.tourAt.z);
    this.camera.lookAt(this.tourLook.x, this.tourLook.y + TOUR_LIFT, this.tourLook.z);
  }

  private resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;

    /* `canvas.width` is the drawing buffer, already multiplied by the pixel
       ratio; `clientWidth` is CSS pixels. Comparing them directly reruns
       setSize every frame on any HiDPI display. */
    const ratio = this.renderer.getPixelRatio();
    if (
      this.canvas.width === Math.round(w * ratio) &&
      this.canvas.height === Math.round(h * ratio)
    ) {
      return;
    }

    this.renderer.setSize(w, h, false);
    this.labelRenderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /* ------------------------------------------------------------ internals */

  /**
   * Recompute which markers are near enough to draw.
   *
   * Throttled on distance rather than time: the set only changes when the
   * camera moves, and re-testing several hundred markers every frame to
   * discover that nothing changed is the kind of cost that shows up as a
   * mysterious few frames per second on a big map.
   */
  private applyVisibility(force = false) {
    if (this.markerDistance === null) {
      if (force || !Number.isNaN(this.markerCentre.x)) {
        this.markerCentre.set(NaN, NaN, NaN);
        this.markers.setVisible(null);
        this.edges.setVisible(null);
        this.labels.setVisible(null);
      }
      return;
    }

    const centre = this.fly.active ? this.camera.position : this.orbit.target;
    if (!force && centre.distanceToSquared(this.markerCentre) < MARKER_RECHECK ** 2) return;
    this.markerCentre.copy(centre);

    const limit = this.markerDistance ** 2;
    const ids = new Set<string>();
    for (const m of this.graph?.markers ?? []) {
      /* A pinned marker is on the planned route, and the route is exempt from
         the distance slider — see `MarkerDatum.pinned`. */
      if (m.pinned) {
        ids.add(m.id);
        continue;
      }
      const dx = m.x + 0.5 - centre.x;
      const dy = m.y + 0.5 - centre.y;
      const dz = m.z + 0.5 - centre.z;
      if (dx * dx + dy * dy + dz * dz <= limit) ids.add(m.id);
    }

    this.markers.setVisible(ids);
    this.edges.setVisible(ids);
    this.labels.setVisible(ids);
  }

  private applyFog() {
    const far = this.radius * 16;
    this.scene.fog = new THREE.Fog(SKY, far * 0.55, far * 1.05);
  }

  /**
   * Attach or detach the drag gizmo.
   *
   * It is off while flying: the pointer is locked to the camera, so there is
   * no pointer left to drag an arrow with.
   */
  private applyGizmo() {
    const at = this.selection ? this.markers.positionOf(this.selection) : null;
    const show = Boolean(at) && this.gizmoEnabled && !this.fly.active && !this.tour;

    if (!show) {
      this.gizmo.detach();
      this.gizmo.enabled = false;
      return;
    }
    /* Not while dragging: writing the position back mid-drag from the state
       the drag itself produced makes the gizmo fight the pointer. */
    if (!this.dragging && at) this.gizmoTarget.position.copy(at);
    this.gizmo.enabled = true;
    this.gizmo.attach(this.gizmoTarget);
  }
}
