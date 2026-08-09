/**
 * Which world folder a map is looking at, remembered per map.
 *
 * Deliberately local rather than a column on `maps`: the path is a property of
 * *this machine*, not of the map. Two people opening the same map keep their
 * own save on their own disk, and nothing about the graph changes if the folder
 * moves. If world sharing ever arrives it will be a server-side world id — a
 * different thing from this, which is why it is not in the database now.
 */

import type { MarkerMode } from './scene/graphData';

const KEY = 'mapgraph.world.v1';

export interface WorldPref {
  /** Absolute path to the world folder — the one containing level.dat. */
  root: string;
  /** Namespaced dimension id, e.g. `minecraft:overworld`. */
  dimensionId: string;
  /** Render distance in chunks. */
  renderDistance: number;
  /** The base filter for which markers to draw. Never `route` — see below. */
  markerMode: Exclude<MarkerMode, 'route'>;
  /**
   * Narrow the scene to a planned trip, overriding `markerMode` while one is up.
   *
   * Off by default: seeing the route in the context of the rooms around it is
   * the more common want, and this is the specialised view rather than the
   * ordinary one.
   */
  routeOnly: boolean;
  /** How far a marker stays on screen, in blocks. `UNLIMITED` means no cull. */
  markerDistance: number;
  /** How far a name stays on screen, in blocks. */
  labelDistance: number;
  /**
   * Multiplier on the tour's cruise speed. 1 is the speed it has always run at.
   *
   * A weight rather than a blocks-per-second figure, so it scales whatever the
   * tour is doing at that instant: the ease in and out at the ends of the route
   * still applies underneath, just faster or slower throughout.
   */
  tourSpeed: number;
}

/**
 * Slider maximum, and the value that means "do not cull at all".
 *
 * A distance filter needs an off position, and a separate checkbox for it would
 * be a second control for one idea. The top of the slider is that off position.
 */
export const UNLIMITED = 2000;

/** Range of the tour speed weight. 1 is unchanged from the built-in speed. */
export const TOUR_SPEED_MIN = 0.25;
export const TOUR_SPEED_MAX = 4;

/**
 * Blocks per second the tour cruises at when the weight is 1.
 *
 * Lives here rather than in the view so the sidebar can show what a weight
 * works out to without importing the scene — and with it, three.js — into the
 * main bundle.
 */
export const TOUR_SPEED_BASE = 18;

export const DEFAULT_WORLD_PREF: WorldPref = {
  root: '',
  dimensionId: 'minecraft:overworld',
  renderDistance: 12,
  markerMode: 'all',
  routeOnly: false,
  /* Off by default: markers behaved this way before the slider existed. */
  markerDistance: UNLIMITED,
  labelDistance: 220,
  /* Neutral by default: the tour runs exactly as it did before this existed. */
  tourSpeed: 1
};

const MARKER_MODES: Array<Exclude<MarkerMode, 'route'>> = ['all', 'selected'];

type Stored = Record<string, Partial<WorldPref>>;

const clampDistance = (value: number | undefined, fallback: number) =>
  Number.isFinite(value) ? Math.min(UNLIMITED, Math.max(20, Math.round(value!))) : fallback;

function readAll(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Stored) : {};
  } catch {
    return {};
  }
}

export function loadWorldPref(mapId: string): WorldPref {
  const stored = readAll()[mapId];

  /* "Near the camera" used to be a mode with its own radius; it is now a
     distance that applies in every mode. Carry the radius across so anyone
     already using it keeps the view they had. */
  const legacyRadius =
    (stored as { markerMode?: string; markerRadius?: number } | undefined)?.markerMode === 'near'
      ? (stored as { markerRadius?: number }).markerRadius
      : undefined;

  return {
    root: typeof stored?.root === 'string' ? stored.root : DEFAULT_WORLD_PREF.root,
    dimensionId:
      typeof stored?.dimensionId === 'string' ? stored.dimensionId : DEFAULT_WORLD_PREF.dimensionId,
    renderDistance: Number.isFinite(stored?.renderDistance)
      ? Math.min(24, Math.max(2, Math.round(stored!.renderDistance!)))
      : DEFAULT_WORLD_PREF.renderDistance,
    markerMode:
      stored?.markerMode && MARKER_MODES.includes(stored.markerMode)
        ? stored.markerMode
        : DEFAULT_WORLD_PREF.markerMode,
    /* `route` used to be one of the modes, and the *default* one — so a stored
       `route` is almost always just that default having been written out, not
       a choice anyone made. It does not carry across: the toggle starts off,
       which is what someone who never picked it would expect. */
    routeOnly: typeof stored?.routeOnly === 'boolean' ? stored.routeOnly : false,
    markerDistance: clampDistance(
      stored?.markerDistance ?? legacyRadius,
      DEFAULT_WORLD_PREF.markerDistance
    ),
    labelDistance: clampDistance(stored?.labelDistance, DEFAULT_WORLD_PREF.labelDistance),
    tourSpeed: Number.isFinite(stored?.tourSpeed)
      ? Math.min(TOUR_SPEED_MAX, Math.max(TOUR_SPEED_MIN, stored!.tourSpeed!))
      : DEFAULT_WORLD_PREF.tourSpeed
  };
}

export function saveWorldPref(mapId: string, patch: Partial<WorldPref>) {
  try {
    const all = readAll();
    all[mapId] = { ...loadWorldPref(mapId), ...patch };
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* private mode / quota — the path simply will not be remembered */
  }
}
