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

import { PALETTE } from '../src/graph/model';
import type { RoutePlan } from '../src/graph/pathfinding';
import { buildGraphData, isPlaced, placedAt, routeHighlight, routeOrder } from '../src/world/scene/graphData';
import { EdgeLayer } from '../src/world/scene/edges';
import { MarkerLayer } from '../src/world/scene/markers';
import { blockInFrontOf } from '../src/world/scene/pick';
import { TOUR_MIN_RATE, tourRate, tourStep } from '../src/world/scene/tour';
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

/* ------------------------------------------------------- planned route */

heading('Planned route');

const plan = (patch: Partial<RoutePlan> = {}): RoutePlan => ({
  mode: 'stops',
  outcome: 'optimal',
  stopReason: null,
  legs: [],
  ok: true,
  hops: 1,
  weight: 1,
  coordChange: 0,
  locationIds: [],
  connectionIds: [],
  detourIds: [],
  impossibleLeg: null,
  statesExplored: 0,
  elapsedMs: 0,
  keysRelevant: 0,
  keysPruned: 0,
  ...patch
});

check('no plan means no highlight', routeHighlight(null, []) === null);
check(
  'an empty plan is not a highlight',
  routeHighlight(plan(), ['a', 'b']) === null,
  'dimming the whole map to show nothing is worse than showing the map'
);

/* a → b, with c reached only to open a lock: a detour is *on* the route. */
const withDetour = routeHighlight(
  plan({ locationIds: ['a', 'c', 'b'], connectionIds: ['ab', 'bc'], detourIds: ['c'] }),
  ['a', 'b']
)!;

check(
  'waypoints take their roles in order',
  withDetour.roles.get('a') === 'start' && withDetour.roles.get('b') === 'end'
);
check('a detour is a stop, not an endpoint', withDetour.roles.get('c') === 'stop');

const roundTrip = routeHighlight(
  plan({ locationIds: ['a', 'b'], connectionIds: ['ab'] }),
  ['a', 'b', 'a']
)!;
check(
  'a round trip reads as its start',
  roundTrip.roles.get('a') === 'start',
  'the same room is both ends; leaving is the more useful of the two'
);

/* A shorter route that leaves c out entirely, so there is something off it. */
const trip = routeHighlight(
  plan({ locationIds: ['a', 'b'], connectionIds: ['ab'] }),
  ['a', 'b']
)!;

const routed = buildGraphData(locations, connections, { route: trip });
const marker = (id: string) => routed.markers.find((m) => m.id === id)!;
const edge = (id: string) => routed.edges.find((e) => e.id === id)!;

check('an on-route marker keeps its own colour', marker('a').color === '#ff0000');
check(
  'an off-route marker is pushed to the background',
  marker('c').color !== locations.c.color && marker('c').color.startsWith('#'),
  `${locations.c.color} → ${marker('c').color}`
);
check(
  'the start is ringed in the start colour',
  marker('a').ring === PALETTE.routeStart,
  marker('a').ring
);
check('the end is ringed in the end colour', marker('b').ring === PALETTE.routeEnd);
check('an unrouted marker has no ring', marker('c').ring === undefined);

check('a route edge takes the route colour', edge('ab').color === PALETTE.route, edge('ab').color);
check(
  'an off-route edge is dimmed, not recoloured to the route',
  edge('bc').color !== PALETTE.route && edge('bc').color !== connections.bc.color
);
check(
  'ephemeral stays dashed on the route',
  edge('bc').dashed === true,
  'the route must not silently change what a connection is'
);

check(
  'off-route labels are marked for dimming',
  routed.labels.find((l) => l.id === 'c')!.dim === true &&
    routed.labels.find((l) => l.id === 'a')!.dim !== true
);

/* With no plan, nothing is dimmed and nothing is ringed — the ordinary case
   must not pay for the routed one. */
const plain = buildGraphData(locations, connections);
check(
  'without a route every marker is its own colour, unringed',
  plain.markers.every((m) => m.ring === undefined) &&
    plain.markers.find((m) => m.id === 'c')!.color === locations.c.color
);
check('without a route no label is dimmed', plain.labels.every((l) => l.dim !== true));

/* Rings are packed into their own instanced draw. */
markers.setData(routed.markers);
const ringMesh = markers.group.children.filter(
  (o): o is THREE.InstancedMesh => (o as THREE.InstancedMesh).isInstancedMesh === true
)[2];
check(
  'the ring pass draws only the ringed markers',
  ringMesh.count === 2,
  `${ringMesh.count} rings for ${routed.markers.length} markers`
);

const ringAt = new THREE.Vector3();
ringMesh.getMatrixAt(0, matrix);
ringAt.setFromMatrixPosition(matrix);
check(
  'a ring sits on its marker',
  ringAt.distanceTo(markers.positionOf(routed.markers.find((m) => m.ring)!.id)!) < 1e-6
);
markers.setData(data.markers);

/* --------------------------------------------------------- visibility */

heading('Thinning a crowded map');

/* Static modes drop things before they ever reach a layer. */
const routeOnly = buildGraphData(locations, connections, { route: trip, mode: 'route' });
check(
  'route mode keeps only the route',
  routeOnly.markers.map((m) => m.id).sort().join() === 'a,b',
  routeOnly.markers.map((m) => m.id).join()
);
check('and drops edges that lost an end', routeOnly.edges.map((e) => e.id).join() === 'ab');
check(
  'route mode drops labels off the route too',
  routeOnly.labels.map((l) => l.id).sort().join() === 'a,b',
  'the names are half the clutter'
);

/* A shortcut joining two rooms the route visits, which the planner declined to
   take: drawing it makes the path ambiguous. */
const withShortcut = index([...Object.values(connections), connection('a-b-2', 'a', 'b')]);
const shortcutRoute = buildGraphData(locations, withShortcut, { route: trip, mode: 'route' });
check(
  'route mode draws the route, not every edge between its rooms',
  shortcutRoute.edges.map((e) => e.id).join() === 'ab',
  'a shortcut the planner refused must not look like part of the path'
);
check(
  'that shortcut is still drawn when not in route mode',
  buildGraphData(locations, withShortcut, { route: trip }).edges.some((e) => e.id === 'a-b-2')
);

check(
  'route mode pins its markers past the distance cull',
  routeOnly.markers.every((m) => m.pinned === true),
  'a path that fades out halfway along is not a path'
);
check(
  'no other mode pins markers',
  buildGraphData(locations, connections, { route: trip }).markers.every((m) => !m.pinned)
);
check(
  'route mode with no plan pins nothing',
  buildGraphData(locations, connections, { route: null, mode: 'route' }).markers.every(
    (m) => !m.pinned
  ),
  'there is no route to keep on screen'
);
check(
  'names are never pinned, in any mode',
  routeOnly.labels.every((l) => !l.pinned) &&
    buildGraphData(locations, connections, { route: trip }).labels.every((l) => !l.pinned),
  'the label distance slider stays in charge of names'
);

check(
  'route mode with no plan shows everything',
  buildGraphData(locations, connections, { route: null, mode: 'route' }).markers.length === 3,
  'an empty scene reads as a bug, not as a filter'
);

const selectedOnly = buildGraphData(locations, connections, { mode: 'selected', selectedId: 'b' });
check(
  'selected mode keeps the selection and its neighbours',
  selectedOnly.markers.map((m) => m.id).sort().join() === 'a,b,c',
  'b connects to a and c'
);
check(
  'selected mode with nothing selected shows everything',
  buildGraphData(locations, connections, { mode: 'selected', selectedId: null }).markers.length === 3
);

/* The radius mode is dynamic, so the layers do the filtering. */
markers.setData(data.markers);
const edgeLayer = new EdgeLayer();
edgeLayer.setData(data.edges);

markers.setVisible(new Set(['a']));
check('hiding packs the draw down to what is left', instanced.count === 1, `count ${instanced.count}`);

raycaster.set(new THREE.Vector3(-40, 64.5, -19.5), new THREE.Vector3(1, 0, 0));
check(
  'picking still resolves the right marker after packing',
  markers.pick(raycaster)?.id === 'a',
  'the hit index is a slot, not a data index'
);

check(
  'a hidden marker keeps its position',
  markers.positionOf('b') !== null,
  'the gizmo and "jump to this" must still work on something off screen'
);

markers.setSelected('c');
check(
  'the selection is shown even when filtered out',
  instanced.count === 2,
  `count ${instanced.count} — a and the forced c`
);
markers.setSelected(null);

const filteredLines = edgeLayer.group.children as THREE.LineSegments[];
edgeLayer.setVisible(new Set(['a']));
check(
  'an edge with one end hidden is dropped',
  filteredLines.every((l) => l.geometry.drawRange.count === 0),
  'a line to a marker that is not drawn points at nothing'
);
edgeLayer.setVisible(new Set(['a', 'b']));
check('an edge with both ends shown is kept', filteredLines[0].geometry.drawRange.count === 2);

markers.setVisible(null);
check('clearing the filter restores every marker', instanced.count === 3);
edgeLayer.dispose();

/* ------------------------------------------------------------ the tour */

heading('Route order for the tour');

const leg = (fromId: string, toId: string, hops: string[]) => ({
  fromId,
  toId,
  found: true,
  steps: hops.map((to, i) => ({
    connectionId: `s${i}`,
    fromId: i === 0 ? fromId : hops[i - 1],
    toId: to,
    weight: 1,
    coordChange: 0
  })),
  hops: hops.length,
  weight: hops.length,
  coordChange: 0,
  detours: []
});

check(
  'no plan is an empty path',
  routeOrder(null).length === 0,
  'nothing to fly along'
);

const ordered = routeOrder(plan({ legs: [leg('a', 'c', ['b', 'c'])] }));
check(
  'the path is the walk, in order',
  ordered.join() === 'a,b,c',
  ordered.join(),
);

/* Two legs meeting at a waypoint must not repeat it. */
const twoLegs = routeOrder(
  plan({ legs: [leg('a', 'b', ['b']), leg('b', 'd', ['c', 'd'])] })
);
check(
  'legs join without doubling the shared stop',
  twoLegs.join() === 'a,b,c,d',
  twoLegs.join()
);

/* A detour walks back through a room it already passed; the tour should too. */
const backtrack = routeOrder(plan({ legs: [leg('a', 'a', ['b', 'a'])] }));
check(
  'backtracking through a room is kept',
  backtrack.join() === 'a,b,a',
  'the walk really does go back that way'
);

check(
  'the order is a walk, not the unordered id set',
  ordered.length === 3 && ordered[0] === 'a' && ordered[2] === 'c',
  'plan.locationIds has no order and cannot be flown along'
);

/* ------------------------------------------------------- tour speed */

heading('Tour speed weight');

const LEN = 500;
const DT = 1 / 60;

check(
  'the weight scales the step exactly',
  Math.abs(tourStep(0.5, DT, LEN, 2) - 2 * tourStep(0.5, DT, LEN, 1)) < 1e-12,
  '200% is twice the distance per frame'
);

check(
  'and scales down the same way',
  Math.abs(tourStep(0.5, DT, LEN, 0.5) - 0.5 * tourStep(0.5, DT, LEN, 1)) < 1e-12,
  '50% is half'
);

check(
  'weights compose with the base speed, not with each other',
  Math.abs(tourStep(0.5, DT, LEN, 4) - 2 * tourStep(0.5, DT, LEN, 2)) < 1e-12,
  '400% is twice 200%'
);

/* The ease ramp must survive the weight — a faster tour is the same journey
   played faster, not a differently shaped one. */
const shapeHolds = [0, 0.02, 0.05, 0.3, 0.5, 0.8, 0.97, 1].every((u) => {
  const slow = tourStep(u, DT, LEN, 1);
  const fast = tourStep(u, DT, LEN, 3);
  return slow === 0 ? fast === 0 : Math.abs(fast / slow - 3) < 1e-12;
});
check('the ease shape is unchanged at every point', shapeHolds, 'ratio is 3 all along');

check(
  'the ends are slower than the middle',
  tourRate(0) < tourRate(0.5) && tourRate(1) < tourRate(0.5),
  'the tour still pulls away and settles'
);

check(
  'the ramp never stalls',
  tourRate(0) >= TOUR_MIN_RATE && tourRate(0) > 0,
  'a rate of zero would park the camera at the start forever'
);

check(
  'a default weight leaves the old behaviour alone',
  tourStep(0.5, DT, LEN) === tourStep(0.5, DT, LEN, 1),
  'omitting the weight is 100%'
);

/* Long routes must not divide by a zero length. */
check('a zero-length route does not divide by zero', Number.isFinite(tourStep(0, DT, 0, 1)));

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
