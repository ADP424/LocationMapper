/**
 * The map, reduced to what the 3D scene needs.
 *
 * A location is drawable only if all three coordinates are set — two out of
 * three is not a point in space, and guessing the third would put a marker
 * somewhere the user never said. Unplaced locations are counted instead, so the
 * sidebar can offer to place them.
 *
 * This is also where a planned trip turns into colours. The 2D canvas does the
 * same job with Cytoscape classes and a stylesheet; there is no stylesheet for
 * a scene graph, so the rule lives here and both views agree on the palette.
 */

import { PALETTE } from '../../graph/model';
import type { RoutePlan } from '../../graph/pathfinding';
import type { Connection, Location } from '../../types';
import type { EdgeDatum } from './edges';
import type { LabelDatum } from './labels';
import type { GraphData } from './worldView';
import type { MarkerDatum } from './markers';

export interface Placed {
  x: number;
  y: number;
  z: number;
}

export function placedAt(location: Location): Placed | null {
  if (location.coordX === null || location.coordY === null || location.coordZ === null) return null;
  return { x: location.coordX, y: location.coordY, z: location.coordZ };
}

export function isPlaced(location: Location): boolean {
  return placedAt(location) !== null;
}

/* ------------------------------------------------------------ the route */

/**
 * What a planned trip marks out, resolved to ids.
 *
 * Mirrors `applyHighlight` in GraphCanvas so the two canvases cannot disagree
 * about what "on the route" means: the plan's own locations and connections,
 * plus roles for the waypoints the user asked for and the detours the planner
 * added to open a locked door.
 */
export interface RouteHighlight {
  locationIds: Set<string>;
  connectionIds: Set<string>;
  roles: Map<string, 'start' | 'stop' | 'end'>;
}

export function routeHighlight(
  plan: RoutePlan | null,
  waypoints: string[]
): RouteHighlight | null {
  /* An empty plan is not a highlight — dimming the entire map to show nothing
     is worse than showing the map. */
  if (!plan || (plan.locationIds.length === 0 && plan.connectionIds.length === 0)) return null;

  const roles = new Map<string, 'start' | 'stop' | 'end'>();
  /* Rooms entered only to unlock a gate, not because they were asked for. */
  for (const id of plan.detourIds) roles.set(id, 'stop');
  for (const id of waypoints) roles.set(id, 'stop');
  /* End before start, so a round trip — where the same room is both — reads as
     the start. Leaving somewhere is the more useful of the two to see. */
  if (waypoints.length) {
    roles.set(waypoints[waypoints.length - 1], 'end');
    roles.set(waypoints[0], 'start');
  }

  return {
    locationIds: new Set(plan.locationIds),
    connectionIds: new Set(plan.connectionIds),
    roles
  };
}

/**
 * The route in the order it is walked, as location ids.
 *
 * `plan.locationIds` is a set of everything on the route with no order to it,
 * which is fine for deciding what to draw and useless for flying along. The
 * legs carry the actual traversal: each leg starts where the last one ended,
 * and its steps are the hops in sequence — including the doubling back a
 * detour through a key room implies, which is part of the walk and should be
 * part of the tour.
 */
export function routeOrder(plan: RoutePlan | null): string[] {
  if (!plan) return [];
  const out: string[] = [];
  for (const leg of plan.legs) {
    if (out[out.length - 1] !== leg.fromId) out.push(leg.fromId);
    for (const step of leg.steps) out.push(step.toId);
  }
  return out;
}

const ROLE_COLORS: Record<'start' | 'stop' | 'end', string> = {
  start: PALETTE.routeStart,
  stop: PALETTE.routeStop,
  end: PALETTE.routeEnd
};

/**
 * How far an off-route thing is pushed towards the background.
 *
 * The 2D canvas drops opacity to 0.18 for this. Opacity is not available here
 * without a second material — the markers share one so they can be instanced —
 * so the equivalent is done in colour, which for unlit geometry is the same
 * thing to the eye.
 */
const DIM_TOWARDS = { r: 0x33, g: 0x3d, b: 0x4a };
const DIM_AMOUNT = 0.78;

/** Parse `#rgb`/`#rrggbb`; anything else is left to the layer's own fallback. */
function parseHex(css: string): { r: number; g: number; b: number } | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(css.trim());
  if (!m) return null;
  const hex =
    m[1].length === 3
      ? m[1]
          .split('')
          .map((c) => c + c)
          .join('')
      : m[1];
  const n = parseInt(hex, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function dim(css: string): string {
  const rgb = parseHex(css);
  if (!rgb) return css;
  const mix = (a: number, b: number) => Math.round(a + (b - a) * DIM_AMOUNT);
  const hex = (v: number) => v.toString(16).padStart(2, '0');
  return `#${hex(mix(rgb.r, DIM_TOWARDS.r))}${hex(mix(rgb.g, DIM_TOWARDS.g))}${hex(
    mix(rgb.b, DIM_TOWARDS.b)
  )}`;
}

/* ----------------------------------------------------------- visibility */

/**
 * Which markers are worth drawing at all.
 *
 * A map of a few dozen rooms reads fine with everything on screen; a map of
 * several hundred is a wall of octahedra with the thing you are looking for
 * somewhere behind it.
 *
 * Distance is deliberately not one of these. It changes as the camera moves,
 * so the view applies it per frame on top of whichever mode is chosen — the two
 * compose, rather than one replacing the other.
 */
export type MarkerMode = 'all' | 'route' | 'selected';

/**
 * `route` is the default, and doubles as the automatic behaviour: with no plan
 * there is nothing to narrow to, so it shows everything. Planning a trip is
 * therefore enough to clear the map down to the path, without also having to
 * come over here and say so.
 */
export const MARKER_MODE_LABELS: Record<MarkerMode, string> = {
  route: 'The Planned Route, When There Is One',
  all: 'Everything',
  selected: 'Selected And Its Connections'
};

export interface OverlayOptions {
  route?: RouteHighlight | null;
  mode?: MarkerMode;
  selectedId?: string | null;
}

/**
 * The ids a static mode allows, or null when everything is allowed.
 *
 * `route` with no plan and `selected` with nothing selected both fall back to
 * showing everything: a mode that silently empties the scene looks like a bug,
 * and the sidebar says which mode is active anyway.
 */
function allowedIds(
  locations: Record<string, Location>,
  connections: Record<string, Connection>,
  options: OverlayOptions
): Set<string> | null {
  if (options.mode === 'route') {
    return options.route ? new Set(options.route.locationIds) : null;
  }
  if (options.mode === 'selected') {
    const id = options.selectedId;
    if (!id || !locations[id]) return null;
    const keep = new Set([id]);
    for (const c of Object.values(connections)) {
      if (c.sourceId === id) keep.add(c.targetId);
      else if (c.targetId === id) keep.add(c.sourceId);
    }
    return keep;
  }
  return null;
}

/* ------------------------------------------------------------- assembly */

export function buildGraphData(
  locations: Record<string, Location>,
  connections: Record<string, Connection>,
  options: OverlayOptions = {}
): GraphData {
  const route = options.route ?? null;
  const allowed = allowedIds(locations, connections, options);
  /* Showing the route and nothing else: its names are then the whole point of
     the picture, so none of them may be dropped for being far away. */
  const routeOnly = options.mode === 'route' && route !== null;

  const markers: MarkerDatum[] = [];
  const labels: LabelDatum[] = [];
  const points = new Map<string, Placed>();

  for (const location of Object.values(locations)) {
    const at = placedAt(location);
    if (!at) continue;
    if (allowed && !allowed.has(location.id)) continue;
    points.set(location.id, at);

    const own = location.color || '#7fb3ff';
    const onRoute = !route || route.locationIds.has(location.id);
    const role = route?.roles.get(location.id);

    markers.push({
      id: location.id,
      color: onRoute ? own : dim(own),
      /* A ring is how a waypoint says which kind of stop it is; the marker
         keeps its own colour underneath so the map still reads normally. */
      ring: onRoute && role ? ROLE_COLORS[role] : undefined,
      ...at
    });
    labels.push({
      id: location.id,
      text: location.name || 'Untitled',
      color: onRoute ? own : dim(own),
      dim: !onRoute,
      pinned: routeOnly,
      ...at
    });
  }

  const edges: EdgeDatum[] = [];
  for (const connection of Object.values(connections)) {
    const a = points.get(connection.sourceId);
    const b = points.get(connection.targetId);
    if (!a || !b) continue;
    const own = connection.color || '#8aa2c0';
    const onRoute = route?.connectionIds.has(connection.id) ?? false;
    /* Route mode means the route, not "anything joining two rooms the route
       happens to visit" — a shortcut the planner declined to take is exactly
       the sort of line that makes a drawn path ambiguous. */
    if (options.mode === 'route' && route && !onRoute) continue;
    edges.push({
      id: connection.id,
      color: !route ? own : onRoute ? PALETTE.route : dim(own),
      dashed: connection.ephemeral,
      sourceId: connection.sourceId,
      targetId: connection.targetId,
      a,
      b
    });
  }

  /* Stable order keeps instance indices from shuffling between rebuilds, which
     would otherwise make every marker flicker to a new colour on any edit. */
  markers.sort((p, q) => (p.id < q.id ? -1 : 1));
  labels.sort((p, q) => (p.id < q.id ? -1 : 1));
  edges.sort((p, q) => (p.id < q.id ? -1 : 1));

  return { markers, edges, labels };
}
