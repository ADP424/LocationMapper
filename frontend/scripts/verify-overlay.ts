/**
 * The graph overlay, checked without a GPU.
 *
 * Everything here is scene-graph arithmetic — where a marker ends up for a
 * given block coordinate, which connections are drawable, which marker a ray
 * hits, which block a click means. None of it needs WebGL, and all of it is the
 * kind of off-by-half-a-block mistake that looks plausible on screen: a marker
 * sitting in the corner of its block rather than the centre reads as fine until
 * you compare it against the coordinate in the inspector.
 *
 *   npm run verify:overlay
 */

import * as THREE from 'three';

import { buildGraphData, isPlaced, placedAt } from '../src/world/scene/graphData';
import { EdgeLayer } from '../src/world/scene/edges';
import { MarkerLayer } from '../src/world/scene/markers';
import { blockInFrontOf } from '../src/world/scene/pick';
import type { Connection, Location } from '../src/types';

let failures = 0;

function check(label: string, ok: boolean, detail = '') {
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
  else {
    failures++;
    console.log(`  \x1b[31m✗ ${label}\x1b[0m  ${detail}`);
  }
}

function heading(text: string) {
  console.log(`\n\x1b[1m${text}\x1b[0m`);
}

/* ------------------------------------------------------------- fixtures */

const location = (id: string, patch: Partial<Location> = {}): Location => ({
  id,
  mapId: 'map',
  groupId: null,
  name: id,
  kind: '',
  size: 1,
  layer: '',
  notes: '',
  color: '#7fb3ff',
  textColor: '#ffffff',
  visited: false,
  x: null,
  y: null,
  coordX: null,
  coordY: null,
  coordZ: null,
  labelIds: [],
  createdAt: '',
  updatedAt: '',
  ...patch
});

const connection = (id: string, sourceId: string, targetId: string, patch: Partial<Connection> = {}): Connection => ({
  id,
  mapId: 'map',
  sourceId,
  targetId,
  name: '',
  notes: '',
  travelKind: '',
  color: '#8aa2c0',
  textColor: '#ffffff',
  arrowSource: false,
  arrowTarget: true,
  ephemeral: false,
  locked: false,
  lockNote: '',
  weight: 1,
  outDx: null,
  outDy: null,
  inDx: null,
  inDy: null,
  requires: [],
  labelIds: [],
  createdAt: '',
  updatedAt: '',
  ...patch
});

const index = <T extends { id: string }>(rows: T[]): Record<string, T> =>
  Object.fromEntries(rows.map((r) => [r.id, r]));

/* --------------------------------------------------- what is drawable */

heading('Placement');

const locations = index([
  location('a', { coordX: 10, coordY: 64, coordZ: -20, color: '#ff0000' }),
  location('b', { coordX: -5, coordY: 70, coordZ: 8 }),
  location('c', { coordX: 0, coordY: 0, coordZ: 0 }),
  /* Two axes out of three is not a point in space. */
  location('half', { coordX: 3, coordY: 4 }),
  location('none')
]);

check('all three coordinates set counts as placed', isPlaced(locations.a));
check('origin counts as placed, not as missing', isPlaced(locations.c), '0,0,0 is a real place');
check('two of three axes is unplaced', !isPlaced(locations.half));
check('no coordinates is unplaced', !isPlaced(locations.none));
check('negative coordinates survive', placedAt(locations.a)?.z === -20);

const connections = index([
  connection('ab', 'a', 'b'),
  connection('bc', 'b', 'c', { ephemeral: true }),
  /* An edge to something with no coordinates has nowhere to end. */
  connection('a-half', 'a', 'half'),
  connection('a-none', 'a', 'none')
]);

const data = buildGraphData(locations, connections);

check('one marker per placed location', data.markers.length === 3, `${data.markers.length} markers`);
check('one label per marker', data.labels.length === data.markers.length);
check('edges to unplaced ends are dropped', data.edges.length === 2, `${data.edges.length} edges`);
check(
  'ephemeral connections are the dashed ones',
  data.edges.filter((e) => e.dashed).map((e) => e.id).join() === 'bc'
);
check(
  'marker order is stable across rebuilds',
  buildGraphData(locations, connections).markers.map((m) => m.id).join() ===
    data.markers.map((m) => m.id).join(),
  'instance indices must not shuffle'
);

/* ------------------------------------------------------ marker geometry */

heading('Marker placement');

const markers = new MarkerLayer();
markers.setData(data.markers);

/* Block n spans [n, n+1) on every axis, negatives included: the centre of
   block -20 is -19.5, not -20.5. Getting this backwards puts every marker in
   the neighbouring block on the negative side of the world. */
const a = markers.positionOf('a')!;
check(
  'a marker sits at the centre of its block',
  a.x === 10.5 && a.y === 64.5 && a.z === -19.5,
  `(${a.x}, ${a.y}, ${a.z}) for block (10, 64, -20)`
);
check('an unplaced id has no position', markers.positionOf('none') === null);

const instanced = markers.group.children.find(
  (o): o is THREE.InstancedMesh => (o as THREE.InstancedMesh).isInstancedMesh === true
)!;
check('one instance is drawn per marker', instanced.count === 3, `count ${instanced.count}`);
check(
  'unused capacity is allocated but not drawn',
  instanced.instanceMatrix.count > instanced.count,
  `capacity ${instanced.instanceMatrix.count}`
);

const matrix = new THREE.Matrix4();
const at = new THREE.Vector3();
const order = data.markers.map((m) => m.id);
instanced.getMatrixAt(order.indexOf('a'), matrix);
at.setFromMatrixPosition(matrix);
check(
  'the instance matrix agrees with positionOf',
  at.distanceTo(a) < 1e-6,
  `matrix (${at.x}, ${at.y}, ${at.z})`
);

const colour = new THREE.Color();
instanced.getColorAt(order.indexOf('a'), colour);
check(
  'per-instance colour comes from the location',
  colour.getHexString() === 'ff0000',
  `#${colour.getHexString()}`
);

/* Editing without adding must not reallocate — a fresh InstancedMesh every
   drag frame would upload a new GPU buffer sixty times a second. */
const before = instanced.instanceMatrix;
markers.setData([{ ...data.markers[0], x: 11 }, data.markers[1]]);
check('shrinking the set reuses the buffers', instanced.instanceMatrix === before);
check('and redraws only what is left', instanced.count === 2, `count ${instanced.count}`);
markers.setData(data.markers);

/* ---------------------------------------------------------- picking */

heading('Picking');

const raycaster = new THREE.Raycaster();

/* Straight down the +X axis through the centre of marker "a". */
raycaster.set(new THREE.Vector3(-40, 64.5, -19.5), new THREE.Vector3(1, 0, 0));
const hit = markers.pick(raycaster);
check('a ray through a marker picks it', hit?.id === 'a', hit ? `hit ${hit.id}` : 'no hit');

raycaster.set(new THREE.Vector3(-40, 200, -19.5), new THREE.Vector3(1, 0, 0));
check('a ray through empty space picks nothing', markers.pick(raycaster) === null);

/* Two markers on one ray: the near one wins. */
markers.setData([
  { id: 'near', color: '#ffffff', x: 0, y: 0, z: 0 },
  { id: 'far', color: '#ffffff', x: 40, y: 0, z: 0 }
]);
raycaster.set(new THREE.Vector3(-20, 0.5, 0.5), new THREE.Vector3(1, 0, 0));
check('the nearest marker along the ray wins', markers.pick(raycaster)?.id === 'near');
markers.setData(data.markers);

/* ------------------------------------------------------- block picking */

heading('Block from a click');

/* Looking down at the top face of the block at (5, 63, 5): the surface is at
   y = 64, and what the click means is the air above it, not the stone. */
const down = new THREE.Vector3(0, -1, 0);
const top = blockInFrontOf(new THREE.Vector3(5.5, 64, 5.5), down);
check(
  'clicking a floor gives the air above it',
  top.x === 5 && top.y === 64 && top.z === 5,
  `(${top.x}, ${top.y}, ${top.z})`
);

/* A wall face at x = 8, looked at from -X: the air is at x = 7. */
const east = new THREE.Vector3(1, 0, 0);
const wall = blockInFrontOf(new THREE.Vector3(8, 70.5, 3.5), east);
check(
  'clicking a wall gives the air in front of it',
  wall.x === 7 && wall.y === 70 && wall.z === 3,
  `(${wall.x}, ${wall.y}, ${wall.z})`
);

/* Negative coordinates floor away from zero, which is where an off-by-one
   between round() and floor() would show up. */
const negative = blockInFrontOf(new THREE.Vector3(-3, 64, -7.5), east);
check(
  'negative coordinates floor the right way',
  negative.x === -4 && negative.z === -8,
  `(${negative.x}, ${negative.y}, ${negative.z})`
);

/* ---------------------------------------------------------- edges */

heading('Connections');

const edges = new EdgeLayer();
edges.setData(data.edges);

const lines = edges.group.children as THREE.LineSegments[];
check('solid and dashed are separate draws', lines.length === 2);

const solid = lines[0];
const dashed = lines[1];
check('the solid pass draws one segment', solid.geometry.drawRange.count === 2);
check('the dashed pass draws one segment', dashed.geometry.drawRange.count === 2);

const positions = solid.geometry.getAttribute('position');
const from = new THREE.Vector3().fromBufferAttribute(positions, 0);
const to = new THREE.Vector3().fromBufferAttribute(positions, 1);
check(
  'an edge runs between the two marker centres',
  from.distanceTo(markers.positionOf('a')!) < 1e-6 && to.distanceTo(markers.positionOf('b')!) < 1e-6,
  `(${from.x}, ${from.y}, ${from.z}) → (${to.x}, ${to.y}, ${to.z})`
);

check(
  'dash lengths are baked for the real segment length',
  Boolean(dashed.geometry.getAttribute('lineDistance')),
  'without this a dragged edge keeps its old dash spacing'
);

edges.setData([]);
check('an empty set hides the lines rather than drawing junk', !solid.visible && !dashed.visible);

/* ---------------------------------------------------------- teardown */

markers.dispose();
edges.dispose();
check('disposing empties the scene graph', markers.group.children.length <= 1);

console.log(
  failures === 0
    ? '\n\x1b[32mAll overlay checks passed.\x1b[0m\n'
    : `\n\x1b[31m${failures} check${failures === 1 ? '' : 's'} failed.\x1b[0m\n`
);
process.exit(failures === 0 ? 0 : 1);
