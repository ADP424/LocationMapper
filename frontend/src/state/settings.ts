import { DEFAULT_SKELETON_THRESHOLD } from '../graph/viewScale';

/** How a left-drag that starts on an element behaves. */
export type DragMode =
  /** Grabs it, as it always has — the view cannot be panned over it. */
  | 'always'
  /** Pans, unless it is the current selection — then it moves. */
  | 'selected'
  /** Always pans; it can only be moved by a layout. */
  | 'never';

export const DRAG_MODES: DragMode[] = ['always', 'selected', 'never'];

export const DRAG_LABELS: Record<DragMode, string> = {
  always: 'Always Draggable',
  selected: 'Draggable When Selected',
  never: 'Never Draggable'
};

/** How an ephemeral connection's two detached halves are drawn. */
export type EphemeralStyle =
  /** A labelled stub box near each room — "⇄ To X" / "From Y ⇄". */
  | 'nodes'
  /** A bare arrow into empty space, with the description on the line. */
  | 'arrows';

export const EPHEMERAL_STYLES: EphemeralStyle[] = ['nodes', 'arrows'];
export const EPHEMERAL_LABELS: Record<EphemeralStyle, string> = {
  nodes: 'Detached Stubs (Boxes)',
  arrows: 'Arrows Into Space'
};

export interface Settings {
  /** Mouse-wheel zoom sensitivity (Cytoscape's wheelSensitivity). */
  scrollSensitivity: number;
  /**
   * Global multiplier on every drawn *name* — locations, connections,
   * groupings. Boxes and line widths are untouched: a name is drawn on an
   * opaque plate in its element's own colour, so a larger name simply covers
   * its neighbours. Layouts reserve room for the box or the name, whichever
   * is bigger, so re-layout after changing it.
   */
  baseScale: number;
  /** Keep names the same size on screen while zooming. Boxes always scale. */
  constantSize: boolean;
  /** 0 = names scale with the zoom, 1 = exactly constant on screen. */
  sizeCompensation: number;
  /** What dragging a grouping box does. */
  groupDrag: DragMode;
  /** What dragging a room does. */
  locationDrag: DragMode;
  /** Detached stub boxes (classic) or bare arrows into space. */
  ephemeralStyle: EphemeralStyle;
  /**
   * Draw connection lines in the zoomed-out skeleton, at a constant on-screen
   * thickness. Off, only the grouping boxes and their titles remain — the
   * cheapest view of a very large map there is.
   */
  skeletonLines: boolean;
  /** Rendered thickness, in pixels, of a weight-1 connection inside the skeleton. */
  skeletonLineWidth: number;
  /**
   * Where the detailed view gives way to the skeleton, as a fraction of the
   * zoom range between "the whole map fits on screen" and maximum zoom.
   * Geometric, and measured against the *live* floor, so it means the same
   * thing on a five-room house and a fifty-thousand-room city. 0 = never flip.
   */
  skeletonThreshold: number;
  /**
   * Allow zooming out past that point. Off, the transition *is* the zoom floor,
   * so the detailed view is the only view.
   */
  allowSkeletonZoom: boolean;
  /** Stop the trip planner after a while instead of searching exhaustively. */
  limitSearchTime: boolean;
  /** Whole seconds. */
  searchTimeLimitSeconds: number;
  /**
   * Recompute `coordinateUnit` from the map's own spacing needs on every
   * coordinate-grid re-layout. On, the field below is read-only output; off,
   * it is the fixed pixel spacing the next re-layout uses instead.
   */
  autoCoordinateUnit: boolean;
  /** Pixels between two adjacent coordinates on a coordinate-grid layout. */
  coordinateUnit: number;
  /**
   * Draw the coordinate lattice behind a coordinate-grid arrangement. Off by
   * default: it is a reading aid for one family of layouts, not a chrome.
   */
  showCoordinateGrid: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  scrollSensitivity: 0.85,
  /* 1 = the name exactly fills its box, which is how boxes are measured */
  baseScale: 1,
  /* re-styles every visible name on each zoom step — not free, so not default */
  constantSize: false,
  sizeCompensation: 0.75,
  groupDrag: 'selected',
  /* a room is easy to nudge by accident while panning over it, so — like a
     grouping — it has to be picked up before it will move */
  locationDrag: 'selected',
  ephemeralStyle: 'nodes',
  skeletonLines: true,
  skeletonLineWidth: 1.5,
  /* exactly where the old, text-legibility-derived boundary sat */
  skeletonThreshold: DEFAULT_SKELETON_THRESHOLD,
  allowSkeletonZoom: true,
  limitSearchTime: true,
  searchTimeLimitSeconds: 10,
  autoCoordinateUnit: true,
  coordinateUnit: 48,
  showCoordinateGrid: false
};

export const SKELETON_LINE_WIDTH_RANGE = [0.75, 6] as const;

export const BASE_SCALE_RANGE = [0.5, 4] as const;
/** A location's own scalar. Past ~10:1 the 1x rooms go sub-pixel once the big one is clamped. */
export const LOCATION_SIZE_MAX = 10;

export const COORDINATE_UNIT_RANGE = [16, 2000] as const;

/* `baseScale` used to scale boxes; it no longer does, so a legacy value is not
   a sensible carry-over — it is reset to the new neutral default instead. */
const KEY = 'mapgraph.settings.v6';
const LEGACY_KEYS = ['mapgraph.settings.v5', 'mapgraph.settings.v4'];

const clamp = (v: number, lo: number, hi: number) =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;

/** Fields from older schemas, read only to migrate an existing install. */
interface LegacySettings {
  sizing?: string; // v5
  hideSmallLabels?: boolean;
  labelCulling?: string;
  /** pre-`skeletonLines`: "is there a skeleton at all" */
  skeletonView?: boolean;
}

export function normaliseSettings(
  s: (Partial<Settings> & LegacySettings) | null | undefined,
  legacy = false
): Settings {
  const constantSize =
    typeof s?.constantSize === 'boolean'
      ? s.constantSize
      : s?.sizing !== undefined
        ? s.sizing !== 'off'
        : Boolean(s?.constantSize);

  return {
    scrollSensitivity: clamp(
      Number(s?.scrollSensitivity ?? DEFAULT_SETTINGS.scrollSensitivity),
      0.1,
      2.5
    ),
    baseScale: legacy
      ? DEFAULT_SETTINGS.baseScale
      : clamp(Number(s?.baseScale ?? DEFAULT_SETTINGS.baseScale), BASE_SCALE_RANGE[0], BASE_SCALE_RANGE[1]),
    constantSize,
    sizeCompensation: clamp(
      Number(s?.sizeCompensation ?? DEFAULT_SETTINGS.sizeCompensation),
      0,
      1
    ),
    groupDrag: DRAG_MODES.includes(s?.groupDrag as DragMode)
      ? (s!.groupDrag as DragMode)
      : DEFAULT_SETTINGS.groupDrag,
    locationDrag: DRAG_MODES.includes(s?.locationDrag as DragMode)
      ? (s!.locationDrag as DragMode)
      : DEFAULT_SETTINGS.locationDrag,
    ephemeralStyle: EPHEMERAL_STYLES.includes(s?.ephemeralStyle as EphemeralStyle)
      ? (s!.ephemeralStyle as EphemeralStyle)
      : DEFAULT_SETTINGS.ephemeralStyle,
    /* the skeleton is no longer optional; an install that had it switched off
       wanted the far-out view uncluttered, which is now what dropping the
       connection lines does */
    skeletonLines: s?.skeletonLines ?? s?.skeletonView ?? DEFAULT_SETTINGS.skeletonLines,
    skeletonLineWidth: clamp(
      Number(s?.skeletonLineWidth ?? DEFAULT_SETTINGS.skeletonLineWidth),
      SKELETON_LINE_WIDTH_RANGE[0],
      SKELETON_LINE_WIDTH_RANGE[1]
    ),
    skeletonThreshold: clamp(
      Number(s?.skeletonThreshold ?? DEFAULT_SETTINGS.skeletonThreshold),
      0,
      1
    ),
    allowSkeletonZoom: s?.allowSkeletonZoom ?? DEFAULT_SETTINGS.allowSkeletonZoom,
    limitSearchTime: s?.limitSearchTime ?? DEFAULT_SETTINGS.limitSearchTime,
    searchTimeLimitSeconds: Math.round(
      clamp(Number(s?.searchTimeLimitSeconds ?? DEFAULT_SETTINGS.searchTimeLimitSeconds), 1, 3600)
    ),
    autoCoordinateUnit: s?.autoCoordinateUnit ?? DEFAULT_SETTINGS.autoCoordinateUnit,
    coordinateUnit: clamp(
      Number(s?.coordinateUnit ?? DEFAULT_SETTINGS.coordinateUnit),
      COORDINATE_UNIT_RANGE[0],
      COORDINATE_UNIT_RANGE[1]
    ),
    showCoordinateGrid: s?.showCoordinateGrid ?? DEFAULT_SETTINGS.showCoordinateGrid
  };
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return normaliseSettings(JSON.parse(raw));
    for (const old of LEGACY_KEYS) {
      const legacy = localStorage.getItem(old);
      if (legacy) return normaliseSettings(JSON.parse(legacy), true);
    }
    return { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* private mode / quota — settings simply will not persist */
  }
}
