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

export interface Settings {
  /** Mouse-wheel zoom sensitivity (Cytoscape's wheelSensitivity). */
  scrollSensitivity: number;
  /** Global multiplier on every drawn location and connection. */
  baseScale: number;
  /** Keep boxes/labels the same size on screen while zooming. */
  constantSize: boolean;
  /** 0 = scale normally, 1 = fully constant on-screen size. */
  sizeCompensation: number;
  /** Let Cytoscape drop labels once they would render very small. */
  hideSmallLabels: boolean;
  /** What dragging a grouping box does. */
  groupDrag: DragMode;
  /** What dragging a room does. */
  locationDrag: DragMode;
  /** Stop the trip planner after a while instead of searching exhaustively. */
  limitSearchTime: boolean;
  /** Whole seconds. */
  searchTimeLimitSeconds: number;
}

export const DEFAULT_SETTINGS: Settings = {
  scrollSensitivity: 0.85,
  baseScale: 2,
  /* re-writes every node's geometry on each zoom step — too costly to default on */
  constantSize: false,
  sizeCompensation: 0.75,
  hideSmallLabels: true,
  /* a superset of the other two modes, so it is the sensible default */
  groupDrag: 'selected',
  /* rooms are small and rarely in the way, so they keep grabbing by default */
  locationDrag: 'always',
  limitSearchTime: true,
  searchTimeLimitSeconds: 10
};

/* bumped so existing installs pick up the new sizing defaults */
const KEY = 'mapgraph.settings.v4';

const clamp = (v: number, lo: number, hi: number) =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;

export function normaliseSettings(s: Partial<Settings> | null | undefined): Settings {
  return {
    scrollSensitivity: clamp(
      Number(s?.scrollSensitivity ?? DEFAULT_SETTINGS.scrollSensitivity),
      0.05,
      4
    ),
    baseScale: clamp(Number(s?.baseScale ?? DEFAULT_SETTINGS.baseScale), 0.25, 32),
    constantSize: s?.constantSize ?? DEFAULT_SETTINGS.constantSize,
    sizeCompensation: clamp(
      Number(s?.sizeCompensation ?? DEFAULT_SETTINGS.sizeCompensation),
      0,
      1
    ),
    hideSmallLabels: s?.hideSmallLabels ?? DEFAULT_SETTINGS.hideSmallLabels,
    groupDrag: DRAG_MODES.includes(s?.groupDrag as DragMode)
      ? (s!.groupDrag as DragMode)
      : DEFAULT_SETTINGS.groupDrag,
    locationDrag: DRAG_MODES.includes(s?.locationDrag as DragMode)
      ? (s!.locationDrag as DragMode)
      : DEFAULT_SETTINGS.locationDrag,
    limitSearchTime: s?.limitSearchTime ?? DEFAULT_SETTINGS.limitSearchTime,
    searchTimeLimitSeconds: Math.round(
      clamp(Number(s?.searchTimeLimitSeconds ?? DEFAULT_SETTINGS.searchTimeLimitSeconds), 1, 3600)
    )
  };
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return normaliseSettings(raw ? JSON.parse(raw) : null);
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
