export interface Settings {
  /** Mouse-wheel zoom sensitivity (Cytoscape's wheelSensitivity). */
  scrollSensitivity: number;
  /** Keep boxes/labels the same size on screen while zooming. */
  constantSize: boolean;
  /** 0 = scale normally, 1 = fully constant on-screen size. */
  sizeCompensation: number;
  /** Let Cytoscape drop labels once they would render very small. */
  hideSmallLabels: boolean;
  /** Stop the trip planner after a while instead of searching exhaustively. */
  limitSearchTime: boolean;
  /** Whole seconds. */
  searchTimeLimitSeconds: number;
}

export const DEFAULT_SETTINGS: Settings = {
  scrollSensitivity: 0.85,
  constantSize: true,
  sizeCompensation: 0.75,
  hideSmallLabels: true,
  limitSearchTime: true,
  searchTimeLimitSeconds: 10
};

/* bumped so existing installs pick up the new trip planner defaults */
const KEY = 'mapgraph.settings.v3';

const clamp = (v: number, lo: number, hi: number) =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;

export function normaliseSettings(s: Partial<Settings> | null | undefined): Settings {
  return {
    scrollSensitivity: clamp(
      Number(s?.scrollSensitivity ?? DEFAULT_SETTINGS.scrollSensitivity),
      0.05,
      4
    ),
    constantSize: s?.constantSize ?? DEFAULT_SETTINGS.constantSize,
    sizeCompensation: clamp(
      Number(s?.sizeCompensation ?? DEFAULT_SETTINGS.sizeCompensation),
      0,
      1
    ),
    hideSmallLabels: s?.hideSmallLabels ?? DEFAULT_SETTINGS.hideSmallLabels,
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
