/**
 * Phase 0 render spike — throwaway, not part of the app bundle.
 *
 * Proves the whole path end to end: world folder -> region files -> parseChunk
 * -> appearance lookup -> three.js geometry, with the Minecraft-to-three
 * coordinate mapping unmodified (both are Y-up, X east, Z south).
 *
 * Deliberately naive: one cube instance per exposed block, no greedy meshing.
 * The point is to confirm correctness and to measure how bad naive is, which is
 * the number that justifies building the greedy mesher in Phase 2.
 *
 *   npm run dev   ->   http://localhost:5173/spike.html
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { unknownBlockNames } from '../anvil/blocks';
import type { ParsedChunk } from '../anvil/chunk';
import { AnvilError } from '../anvil/errors';
import { meshWorld, type FaceBuffers } from '../mesh/faces';
import { writeRegion } from '../anvil/testkit/regionWrite';
import { synthesiseChunks } from '../anvil/testkit/syntheticWorld';
import { FlyControls } from '../scene/flyControls';
import { WorldStreamer, type StreamStats } from '../stream/streamer';
import {
  canPickDirectory,
  fromDirectoryInput,
  fromLocalPath,
  pickWorldDirectory,
  type DimensionRef,
  type WorldSource
} from '../source/worldSource';
import { loadRegion, World } from './scan';

const SYNTHETIC_CHUNKS = 8;
/** Cap for the single-file path, where there is no budget control. */
const MAX_SINGLE_FILE_CHUNKS = 256;

/* ------------------------------------------------------------------ scene */

const canvas = document.getElementById('view') as HTMLCanvasElement;
const statsEl = document.getElementById('stats')!;
const errEl = document.getElementById('err')!;
const unknownEl = document.getElementById('unknown')!;
const statusEl = document.getElementById('status')!;
const worldEl = document.getElementById('world')!;
const loaderEl = document.getElementById('loader')!;
const dimSelect = document.getElementById('dim') as HTMLSelectElement;
const distanceSelect = document.getElementById('distance') as HTMLSelectElement;
const centreSelect = document.getElementById('centre') as HTMLSelectElement;
const loadButton = document.getElementById('load') as HTMLButtonElement;
const walkButton = document.getElementById('walk') as HTMLButtonElement;
const streamEl = document.getElementById('stream')!;
const pickButton = document.getElementById('pick') as HTMLButtonElement;
const pickNote = document.getElementById('pick-note')!;
const pathInput = document.getElementById('path') as HTMLInputElement;
const openPathButton = document.getElementById('open-path') as HTMLButtonElement;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fb8de);
scene.fog = new THREE.Fog(0x8fb8de, 260, 900);

/* No lights: the mesher bakes a fixed per-face tint into vertex colours, so a
   MeshBasicMaterial already draws the shading. */

const camera = new THREE.PerspectiveCamera(65, 1, 0.1, 8000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

/**
 * Two cameras over one camera object.
 *
 * Orbiting is right for looking at a loaded area from outside; a maze is
 * interior and reads as a solid box from out there, so the fly camera is what
 * actually lets you see it. They share `camera`, so switching never teleports.
 */
const fly = new FlyControls(camera, canvas, {
  onActiveChange: (active) => {
    controls.enabled = !active;
    walkButton.textContent = active ? 'Exit first person (Esc)' : 'Enter first person (F)';
    document.body.classList.toggle('flying', active);
    if (!active) {
      /* Hand the orbit camera a target in front of where the fly camera was
         left, or it snaps back to wherever the last orbit target was. */
      const ahead = new THREE.Vector3();
      camera.getWorldDirection(ahead);
      controls.target.copy(camera.position).addScaledVector(ahead, 24);
      controls.update();
    }
  }
});

type WorldMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;

/**
 * Turn the mesher's buffers into a drawable mesh.
 *
 * Positions are Int16 straight from the mesher — WebGL takes SHORT attributes
 * natively, so there is no conversion pass. Colours are unsigned bytes flagged
 * normalized, which three maps back to 0..1 on the GPU.
 */
function toMesh(buffers: FaceBuffers | null, opaque: boolean): WorldMesh | null {
  if (!buffers) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Int16BufferAttribute(buffers.positions, 3));
  geometry.setAttribute('color', new THREE.Uint8BufferAttribute(buffers.colors, 3, true));
  geometry.computeBoundingSphere();

  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    /* Double-sided as insurance: a winding mistake would otherwise show up as
       invisible geometry, which is a miserable thing to debug. Faces are only
       emitted where they touch open space, so nothing is drawn twice. */
    side: THREE.DoubleSide,
    ...(opaque ? {} : { transparent: true, opacity: 0.72, depthWrite: false })
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = opaque ? 0 : 1;
  return mesh;
}

function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return;

  /* `canvas.width` is the drawing buffer, already multiplied by the pixel
     ratio; `clientWidth` is CSS pixels. Comparing them directly reruns setSize
     every frame on any HiDPI display. */
  const ratio = renderer.getPixelRatio();
  if (canvas.width === Math.round(w * ratio) && canvas.height === Math.round(h * ratio)) return;

  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

let current: WorldMesh[] = [];

function clearMeshes() {
  for (const o of current) {
    scene.remove(o);
    o.material.dispose();
    o.geometry.dispose();
  }
  current = [];
}

function show(world: World, meshes: WorldMesh[], lookAtY = 70) {
  clearMeshes();
  current = meshes;
  for (const m of meshes) scene.add(m);

  const cx = (world.minX + world.maxX) / 2;
  const cz = (world.minZ + world.maxZ) / 2;
  const span = Math.max(world.maxX - world.minX, world.maxZ - world.minZ, 64);
  controls.target.set(cx, lookAtY, cz);
  camera.position.set(cx + span * 0.7, lookAtY + span * 0.55, cz + span * 0.7);
  camera.far = Math.max(2000, span * 8);
  camera.updateProjectionMatrix();
  scene.fog = new THREE.Fog(0x8fb8de, span * 0.9, span * 3.2);
  controls.update();
}

function report(rows: Array<[string, string, boolean?]>) {
  statsEl.innerHTML = rows
    .map(
      ([k, v, warn]) =>
        `<div class="row${warn ? ' warn' : ''}"><span>${k}</span><span>${v}</span></div>`
    )
    .join('');

  const unknown = unknownBlockNames();
  unknownEl.textContent = unknown.length
    ? `${unknown.length} unrecognised block${unknown.length === 1 ? '' : 's'} drawn magenta — ` +
      'full list logged to the console'
    : '';
  /* The HUD truncates; the console is where the list is actually usable, since
     the point of it is to paste the names into the colour table. */
  if (unknown.length) console.log(`unrecognised blocks (${unknown.length}):\n${unknown.join('\n')}`);
}

const n = (v: number) => v.toLocaleString();
const mb = (v: number) => `${(v / 1024 / 1024).toFixed(1)} MB`;

function status(message: string) {
  statusEl.textContent = message;
}

function busy(on: boolean) {
  loadButton.disabled = on;
  pickButton.disabled = on;
  openPathButton.disabled = on;
}

/** Remembered so a reload does not mean retyping a long Windows path. */
const PATH_KEY = 'anvil-spike-world-path';

/* ----------------------------------------------------------- render step */

/** Mesh a set of chunks, build geometry, frame it. Shared by every load path. */
function render(chunks: ParsedChunk[], extraRows: Array<[string, string, boolean?]>, centreY = 70) {
  const world = new World();
  for (const c of chunks) world.add(c);

  /* Drop the previous geometry before building the next: at these sizes,
     holding two worlds at once is what actually runs the tab out of memory. */
  clearMeshes();

  const mesh = meshWorld(world);
  const t = performance.now();
  const meshes = [toMesh(mesh.opaque, true), toMesh(mesh.translucent, false)].filter(
    (m): m is WorldMesh => m !== null
  );
  const uploadMs = performance.now() - t;

  show(world, meshes, centreY);
  renderer.render(scene, camera);

  const vertexBytes =
    (mesh.opaque?.positions.byteLength ?? 0) +
    (mesh.opaque?.colors.byteLength ?? 0) +
    (mesh.translucent?.positions.byteLength ?? 0) +
    (mesh.translucent?.colors.byteLength ?? 0);

  report([
    ...extraRows,
    ['blocks visited', n(mesh.blocksScanned)],
    ['solid', n(mesh.solid)],
    ['faces', n(mesh.faces)],
    ['vertex data', `${(vertexBytes / 1024 / 1024).toFixed(1)} MB`],
    ['meshing', `${mesh.ms.toFixed(0)} ms`],
    ['geometry upload', `${uploadMs.toFixed(0)} ms`],
    ['draw calls', String(renderer.info.render.calls)],
    ['triangles', n(renderer.info.render.triangles)]
  ]);
}

/* ------------------------------------------------------------ world folder */

let source: WorldSource | null = null;

interface Centre {
  label: string;
  x: number;
  z: number;
  y: number;
}

function centresFor(dimension: DimensionRef): Centre[] {
  const out: Centre[] = [];

  /* Spawn is only meaningful in the overworld — level.dat records one point. */
  if (source?.level && dimension.id === 'minecraft:overworld') {
    const { x, y, z } = source.level.spawn;
    out.push({ label: `spawn (${x}, ${z})`, x, z, y });
  }

  if (dimension.regions.length) {
    const mx = dimension.regions.reduce((s, r) => s + r.rx, 0) / dimension.regions.length;
    const mz = dimension.regions.reduce((s, r) => s + r.rz, 0) / dimension.regions.length;
    const x = Math.round((mx + 0.5) * 512);
    const z = Math.round((mz + 0.5) * 512);
    out.push({ label: `middle of generated area (${x}, ${z})`, x, z, y: 70 });
  }

  out.push({ label: 'origin (0, 0)', x: 0, z: 0, y: 70 });
  return out;
}

function refreshCentres() {
  const dimension = source?.dimensions[dimSelect.selectedIndex];
  if (!dimension) return;
  const centres = centresFor(dimension);
  centreSelect.innerHTML = centres
    .map((c, i) => `<option value="${i}">${c.label}</option>`)
    .join('');
}

function describeWorld(src: WorldSource) {
  const totalRegions = src.dimensions.reduce((s, d) => s + d.regions.length, 0);
  const level = src.level;

  worldEl.hidden = false;
  worldEl.innerHTML =
    `<div class="name">${level?.name || src.label}</div>` +
    `<div class="meta">${
      level ? `${level.versionName || `DataVersion ${level.dataVersion}`} · ` : ''
    }${src.dimensions.length} dimension${src.dimensions.length === 1 ? '' : 's'} · ` +
    `${totalRegions} region file${totalRegions === 1 ? '' : 's'}</div>` +
    (src.levelError ? `<div class="meta" style="color:#e8a33d">${src.levelError}</div>` : '');

  dimSelect.innerHTML = src.dimensions
    .map((d, i) => `<option value="${i}">${d.label} — ${d.regions.length} regions</option>`)
    .join('');

  loaderEl.hidden = src.dimensions.length === 0;
  refreshCentres();

  /* The scan trace is always logged: when a folder yields nothing, the counts
     are the only way to tell a wrong folder from a walk that never ran. */
  const t = src.trace;
  console.log(
    `world scan via ${t.backend}: ${t.directories} directories, ${t.files} files, ` +
      `${t.mca} .mca, ${t.skipped.length} dirs skipped, ${t.errors.length} errors`
  );
  if (t.sample.length) console.log(`first entries seen:\n${t.sample.join('\n')}`);
  if (t.skipped.length) console.log(`skipped by name: ${t.skipped.join(', ')}`);
  if (t.errors.length) console.log(`errors:\n${t.errors.join('\n')}`);

  if (src.dimensions.length === 0) {
    errEl.textContent =
      t.files === 0
        ? `Nothing was read from that folder — ${t.directories} director${
            t.directories === 1 ? 'y' : 'ies'
          } visited, 0 files. If the browser asked for permission, it may have been declined. See the console for what the scan saw.`
        : `Found ${t.files} files but no region data (${t.mca} .mca). ` +
          'Pick the world folder itself — the one containing level.dat and region/. See the console for the paths seen.';
  }
}

async function openSource(load: () => Promise<WorldSource>) {
  errEl.textContent = '';
  /* A new world means new region files; the streamer holds refs into the old
     one, so it cannot survive the swap. */
  stopStreaming();
  lastDimension = null;
  busy(true);
  status('reading folder…');
  try {
    source = await load();
    describeWorld(source);
    status(`${source.dimensions.reduce((s, d) => s + d.regions.length, 0)} region files found`);
  } catch (e) {
    /* The user dismissing the picker is not an error worth shouting about. */
    if (e instanceof DOMException && e.name === 'AbortError') status('');
    else {
      errEl.textContent = e instanceof Error ? e.message : String(e);
      status('');
    }
  } finally {
    busy(false);
  }
}

/* ---------------------------------------------------------- streaming */

/**
 * Streaming replaces the one-shot area load for real worlds.
 *
 * The test world is 72,909 chunks and the measured ceiling is around a thousand
 * at once, so there is no budget at which "the whole world" fits. What there is
 * instead is a window that follows the camera: fly anywhere and the world is
 * there when you arrive, at whatever render distance the hardware sustains.
 */
let streamer: WorldStreamer | null = null;
let lastDimension: DimensionRef | null = null;

function stopStreaming() {
  streamer?.dispose();
  streamer = null;
  streamEl.hidden = true;
}

function showStream(s: StreamStats) {
  streamEl.hidden = false;
  const rows: Array<[string, string]> = [
    ['chunks drawn', n(s.meshed)],
    ['chunks in memory', n(s.loaded)],
    ...(s.pending ? ([['queued', n(s.pending)]] as Array<[string, string]>) : []),
    ['faces', n(s.faces)],
    ['vertex data', mb(s.vertexBytes)],
    ['regions fetched', `${n(s.regionsFetched)} — ${mb(s.bytesFetched)}`],
    ['regions cached', `${n(s.regionsHeld)} — ${mb(s.bytesHeld)}`],
    ['draw calls', String(renderer.info.render.calls)],
    ['triangles', n(renderer.info.render.triangles)]
  ];
  streamEl.innerHTML =
    `<div class="row"><span>state</span><span>${
      s.working ? 'streaming…' : 'idle'
    }</span></div>` +
    rows.map(([k, v]) => `<div class="row"><span>${k}</span><span>${v}</span></div>`).join('');
}

/** Put the camera at a world position and stream around it. */
function goTo(dimension: DimensionRef, x: number, y: number, z: number) {
  clearMeshes(); // any static geometry from the synthetic/single-file paths
  lastDimension = dimension;
  errEl.textContent = '';
  report([]);

  if (!streamer) {
    streamer = new WorldStreamer(scene, dimension, {
      radius: Number(distanceSelect.value),
      onStats: showStream,
      onError: (m) => {
        errEl.textContent = m;
      }
    });
  }

  camera.position.set(x, y + 2, z);
  camera.far = 4000;
  camera.updateProjectionMatrix();

  /* Look along +X at the horizon rather than down at the ground, so the first
     frame after a jump shows the world rather than the block underfoot. */
  controls.target.set(x + 32, y + 2, z);
  controls.update();

  const far = Number(distanceSelect.value) * 16;
  scene.fog = new THREE.Fog(0x8fb8de, far * 0.55, far * 1.05);
  status('');
}

function loadSelectedArea() {
  if (!source) return;
  const dimension = source.dimensions[dimSelect.selectedIndex];
  if (!dimension) return;

  /* A different dimension is a different region set — the streamer is bound to
     one, so switching means a new one. */
  if (lastDimension && lastDimension !== dimension) stopStreaming();

  const centre = centresFor(dimension)[centreSelect.selectedIndex] ?? { x: 0, z: 0, y: 70 };
  goTo(dimension, centre.x, centre.y, centre.z);
}

/* ------------------------------------------------------------- navigation */

/**
 * Click a block to jump the camera there.
 *
 * Distinguished from an orbit drag by how far the pointer moved: OrbitControls
 * owns the drag, and stealing it would make the view unusable.
 */
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pressAt: { x: number; y: number } | null = null;

canvas.addEventListener('pointerdown', (e) => {
  if (e.button === 0 && !fly.active) pressAt = { x: e.clientX, y: e.clientY };
});

canvas.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || !pressAt || fly.active) return;
  const moved = Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y);
  pressAt = null;
  if (moved > 4) return;

  const rect = canvas.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  const hit = raycaster.intersectObjects(streamer ? scene.children : current, true)[0];
  if (!hit) return;

  if (streamer && lastDimension) {
    /* Land above the block rather than inside it — clicking a floor and being
       buried in it is a rotten way to arrive somewhere. */
    goTo(lastDimension, hit.point.x, hit.point.y + 1, hit.point.z);
    status(`moved to ${Math.round(hit.point.x)}, ${Math.round(hit.point.z)}`);
  } else {
    controls.target.copy(hit.point);
    controls.update();
  }
});

walkButton.addEventListener('click', () => {
  if (fly.active) fly.exit();
  else fly.enter();
});

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement)?.tagName === 'INPUT') return;

  /* F is the toggle in both directions; Escape is handled by the browser, which
     releases the lock on its own. */
  if (e.code === 'KeyF' && !fly.active) {
    fly.enter();
    e.preventDefault();
    return;
  }

  /* Speed on the scroll wheel would fight zoom, so it lives on the number row
     the way every other flying camera does. */
  if (fly.active && e.code >= 'Digit1' && e.code <= 'Digit5') {
    fly.speedScale = [0.25, 0.5, 1, 2, 4][Number(e.code.slice(5)) - 1];
    status(`fly speed ${fly.speedScale}x`);
  }
});

/* ------------------------------------------------------- single file paths */

async function loadSingleRegion(bytes: Uint8Array, label: string) {
  stopStreaming();
  lastDimension = null;
  const loaded = await loadRegion(bytes, MAX_SINGLE_FILE_CHUNKS);
  if (loaded.world.list.length === 0) {
    errEl.textContent = loaded.firstFailure || 'No renderable chunks in that region file.';
    report([]);
    return;
  }
  render(loaded.world.list, [
    ['source', label],
    ['chunks in region', n(loaded.chunksInRegion)],
    ['chunks rendered', n(loaded.world.list.length)],
    ['parse + inflate', `${loaded.parseMs.toFixed(0)} ms`],
    ...(loaded.skipped
      ? ([['partial chunks skipped', n(loaded.skipped), true]] as Array<[string, string, boolean]>)
      : [])
  ]);
  if (loaded.failed && loaded.firstFailure) errEl.textContent = loaded.firstFailure;
}

async function loadSynthetic() {
  report([['status', 'generating…']]);
  await new Promise((r) => setTimeout(r, 0));
  const t = performance.now();
  const bytes = await writeRegion(synthesiseChunks(SYNTHETIC_CHUNKS));
  const genMs = performance.now() - t;
  worldEl.hidden = true;
  loaderEl.hidden = true;
  await loadSingleRegion(bytes, `synthetic ${SYNTHETIC_CHUNKS}x${SYNTHETIC_CHUNKS} (${genMs.toFixed(0)} ms)`);
}

/* -------------------------------------------------------------- listeners */

pathInput.value = localStorage.getItem(PATH_KEY) ?? '';

function openTypedPath() {
  const root = pathInput.value.trim().replace(/^"|"$/g, '');
  if (!root) {
    errEl.textContent = 'Type the path to the world folder — the one containing level.dat.';
    return;
  }
  localStorage.setItem(PATH_KEY, root);
  void openSource(() => fromLocalPath(root));
}

openPathButton.addEventListener('click', openTypedPath);
pathInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') openTypedPath();
});

if (canPickDirectory()) {
  pickNote.textContent = 'pick the folder containing level.dat and region/';
  pickButton.addEventListener('click', () => void openSource(pickWorldDirectory));
} else {
  /* Firefox and Safari have no showDirectoryPicker; a directory <input> gets
     the same tree, just without a reusable handle. */
  pickNote.textContent = 'your browser will ask to upload the folder — nothing leaves the page';
  const dirInput = document.createElement('input');
  dirInput.type = 'file';
  dirInput.webkitdirectory = true;
  dirInput.style.display = 'none';
  document.body.appendChild(dirInput);

  pickButton.addEventListener('click', () => dirInput.click());
  dirInput.addEventListener('change', () => {
    if (dirInput.files?.length) void openSource(() => fromDirectoryInput(dirInput.files!));
  });
}

dimSelect.addEventListener('change', refreshCentres);
loadButton.addEventListener('click', loadSelectedArea);
document.getElementById('synth')!.addEventListener('click', () => void loadSynthetic());

document.getElementById('dirfile')!.addEventListener('change', (ev) => {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  void (async () => {
    errEl.textContent = '';
    status(`reading ${file.name}…`);
    worldEl.hidden = true;
    loaderEl.hidden = true;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await loadSingleRegion(bytes, `${file.name} (capped at ${MAX_SINGLE_FILE_CHUNKS} chunks)`);
    } catch (e) {
      errEl.textContent = e instanceof AnvilError ? e.message : String(e);
    } finally {
      status('');
    }
  })();
});

distanceSelect.addEventListener('change', () => {
  const chunks = Number(distanceSelect.value);
  streamer?.setRadius(chunks);
  if (streamer) scene.fog = new THREE.Fog(0x8fb8de, chunks * 8.8, chunks * 16.8);
});

let lastFrame = performance.now();

renderer.setAnimationLoop(() => {
  const now = performance.now();
  /* Clamped: a backgrounded tab resumes with a multi-second gap, and an
     unclamped dt would fling the camera across the world. */
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  resize();
  if (fly.active) fly.update(dt);
  else controls.update();

  /* Orbiting loads around what you are looking at; flying loads around you. */
  streamer?.update(fly.active ? camera.position : controls.target);

  renderer.render(scene, camera);
});

void loadSynthetic();
