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
import { writeRegion } from '../anvil/testkit/regionWrite';
import { synthesiseChunks } from '../anvil/testkit/syntheticWorld';
import { loadArea } from '../source/area';
import {
  canPickDirectory,
  fromDirectoryInput,
  fromLocalPath,
  pickWorldDirectory,
  type DimensionRef,
  type WorldSource
} from '../source/worldSource';
import { loadRegion, scanExposedPadded, World, type ScanResult } from './scan';

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
const budgetSelect = document.getElementById('budget') as HTMLSelectElement;
const centreSelect = document.getElementById('centre') as HTMLSelectElement;
const loadButton = document.getElementById('load') as HTMLButtonElement;
const pickButton = document.getElementById('pick') as HTMLButtonElement;
const pickNote = document.getElementById('pick-note')!;
const pathInput = document.getElementById('path') as HTMLInputElement;
const openPathButton = document.getElementById('open-path') as HTMLButtonElement;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fb8de);
scene.fog = new THREE.Fog(0x8fb8de, 260, 900);

/* Stands in for the fixed per-face tints the real mesher will bake into vertex
   colours: key light from above-ish, strong ambient so nothing goes black. */
const sun = new THREE.DirectionalLight(0xffffff, 1.7);
sun.position.set(0.6, 1, 0.35);
scene.add(sun, new THREE.AmbientLight(0xffffff, 1.25));

const camera = new THREE.PerspectiveCamera(65, 1, 0.1, 4000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const cubeGeometry = new THREE.BoxGeometry(1, 1, 1);

/** Narrower than three's default generics so `.material.dispose()` typechecks. */
type CubeMesh = THREE.InstancedMesh<THREE.BoxGeometry, THREE.MeshLambertMaterial>;

/** One InstancedMesh per pass: opaque blocks, then translucent ones. */
function buildMeshes(scan: ScanResult): CubeMesh[] {
  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();

  const build = (opaque: boolean): CubeMesh | null => {
    const subset = scan.blocks.filter((b) => b.opaque === opaque);
    if (subset.length === 0) return null;

    const material = new THREE.MeshLambertMaterial(
      opaque ? {} : { transparent: true, opacity: 0.65, depthWrite: false }
    );
    const mesh = new THREE.InstancedMesh(cubeGeometry, material, subset.length);
    subset.forEach((b, i) => {
      matrix.setPosition(b.x + 0.5, b.y + 0.5, b.z + 0.5);
      mesh.setMatrixAt(i, matrix);
      mesh.setColorAt(i, color.setHex(b.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return mesh;
  };

  return [build(true), build(false)].filter((m): m is CubeMesh => m !== null);
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

let current: CubeMesh[] = [];

function show(world: World, meshes: CubeMesh[], lookAtY = 70) {
  for (const o of current) {
    scene.remove(o);
    o.material.dispose();
    o.dispose();
  }
  current = meshes;
  for (const m of meshes) scene.add(m);

  const cx = (world.minX + world.maxX) / 2;
  const cz = (world.minZ + world.maxZ) / 2;
  const span = Math.max(world.maxX - world.minX, world.maxZ - world.minZ, 64);
  controls.target.set(cx, lookAtY, cz);
  camera.position.set(cx + span * 0.7, lookAtY + span * 0.55, cz + span * 0.7);
  camera.far = Math.max(2000, span * 6);
  camera.updateProjectionMatrix();
  scene.fog = new THREE.Fog(0x8fb8de, span * 0.8, span * 2.6);
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

/** Scan a set of chunks, build geometry, frame it. Shared by every load path. */
function render(chunks: ParsedChunk[], extraRows: Array<[string, string, boolean?]>, centreY = 70) {
  const world = new World();
  for (const c of chunks) world.add(c);

  const scan = scanExposedPadded(world);
  const t = performance.now();
  const meshes = buildMeshes(scan);
  const uploadMs = performance.now() - t;

  show(world, meshes, centreY);
  renderer.render(scene, camera);

  report([
    ...extraRows,
    ['blocks scanned', n(scan.blocksScanned)],
    ['solid', n(scan.solid)],
    ['buried (culled)', `${((scan.buried / Math.max(1, scan.solid)) * 100).toFixed(1)}%`],
    ['cube instances', n(scan.blocks.length)],
    ['exposure scan', `${scan.ms.toFixed(0)} ms`],
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

async function loadSelectedArea() {
  if (!source) return;
  const dimension = source.dimensions[dimSelect.selectedIndex];
  const centre = centresFor(dimension)[centreSelect.selectedIndex] ?? { x: 0, z: 0, y: 70 };
  const budget = Number(budgetSelect.value);

  errEl.textContent = '';
  busy(true);
  try {
    const area = await loadArea(dimension, centre.x, centre.z, budget, status);
    status('');

    if (area.chunks.length === 0) {
      errEl.textContent =
        area.firstFailure || 'No renderable chunks near that point. Try a different centre.';
      report([]);
      return;
    }

    render(
      area.chunks,
      [
        ['dimension', dimension.label],
        ['centre', `${centre.x}, ${centre.z}`],
        ['regions scanned', n(area.regionsScanned)],
        ['regions read', `${n(area.regionsRead)} — ${mb(area.bytesRead)}`],
        ['chunks available', n(area.chunksAvailable)],
        ['chunks loaded', n(area.chunks.length)],
        ['header scan', `${area.headerMs.toFixed(0)} ms`],
        ['read + parse', `${area.readMs.toFixed(0)} ms`],
        ['area', `${area.maxX - area.minX + 1} x ${area.maxZ - area.minZ + 1} blocks`],
        ...(area.skipped
          ? ([['partial chunks skipped', n(area.skipped), true]] as Array<[string, string, boolean]>)
          : []),
        ...(area.failed
          ? ([['chunks failed', n(area.failed), true]] as Array<[string, string, boolean]>)
          : [])
      ],
      centre.y
    );

    if (area.failed && area.firstFailure) errEl.textContent = area.firstFailure;
  } catch (e) {
    errEl.textContent = e instanceof AnvilError ? e.message : String(e);
    status('');
  } finally {
    busy(false);
  }
}

/* ------------------------------------------------------- single file paths */

async function loadSingleRegion(bytes: Uint8Array, label: string) {
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
loadButton.addEventListener('click', () => void loadSelectedArea());
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

renderer.setAnimationLoop(() => {
  resize();
  controls.update();
  renderer.render(scene, camera);
});

void loadSynthetic();
