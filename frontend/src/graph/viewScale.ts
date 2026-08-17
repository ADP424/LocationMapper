import type { NodeSingular } from 'cytoscape';
import type { Settings } from '../state/settings';

/* ─────────────────────────────────────────────────────────── the zoom range */

export const MIN_ZOOM = 2e-4;
export const MAX_ZOOM = 8;
/**
 * The floor on a map small enough to fit comfortably — `zoomBounds`'s cap on
 * how far out such a map may be pulled, and the reference the default
 * transition threshold is calibrated against. It lives here, beside the range
 * it belongs to, rather than in `zoomBounds`, which re-exports it.
 */
export const DEFAULT_MIN_ZOOM = 0.05;

/** Names never grow past 32× their natural size, so Fit always has a solution. */
export const MAX_COMPENSATION = 32;

/* ──────────────────────────────────────────────────────── render ceilings */

/**
 * Cytoscape rasterises labels into 1024 px texture atlases; past ~900 px they
 * re-render every frame. The ceiling is driven by the 24th-largest visible
 * name, not the largest, so a handful of oversized names simply go uncached
 * instead of shrinking everyone's.
 */
const MAX_RENDERED_LABEL = 900;
export const OVERSIZE_TOLERANCE = 24;

/** Quantisation ladder: 2^(1/16) ≈ 4.4 % rungs. Idempotent and cache-friendly. */
const STEP = 1 / 16;

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const rung = (v: number) => (v <= 0 ? 0 : Math.pow(2, Math.round(Math.log2(v) / STEP) * STEP));
const rungDown = (v: number) => (v <= 0 ? 0 : Math.pow(2, Math.floor(Math.log2(v) / STEP) * STEP));
/** Quarter-octave buckets: panning must not jiggle the eased strength. */
const bucket = (v: number) => (v <= 0 ? 0 : Math.pow(2, Math.round(Math.log2(v) * 4) / 4));

/** Seeded into every element; names vanish below this rendered size, always. */
export const FONT_MIN = { location: 6, portal: 6, group: 5, edge: 7 } as const;

/** A size-1 location's base font (`style.ts`: `'font-size': 12 * tv`). The
 *  skeleton's readability trigger is judged against this reference, not any
 *  individual room's own size scalar. */
const NAME_FONT = 12;

/* ────────────────────────────────────────────────────────────── geometry */

export interface Size {
  w: number;
  h: number;
}

/**
 * The drawn box: shape metrics and the location's own size scalar, never Name
 * Size, never the zoom. Boxes are text-fitted once, at build time, and never
 * change again — layouts, the coordinate grid, hit-testing and the content
 * extent all measure with this, never with `node.width()`, which used to be
 * (and no longer needs to be distinguished from) drawn geometry.
 */
export function baseBox(node: NodeSingular): Size {
  const w = node.data('w');
  const h = node.data('h');
  return {
    w: typeof w === 'number' && w > 0 ? w : node.width(),
    h: typeof h === 'number' && h > 0 ? h : node.height()
  };
}

/** The name's own plate, at Name Size 1 / compensation 1. Already carries the
 *  location's size scalar and the current Name Size (baked in at build time). */
export function namePlate(node: NodeSingular): Size {
  const lw = node.data('lw');
  const lh = node.data('lh');
  return { w: typeof lw === 'number' ? lw : 0, h: typeof lh === 'number' ? lh : 0 };
}

/**
 * What a layout must reserve, per axis: the box or the name's plate, whichever
 * is bigger. A room with a short name is box-bound; a 1× room under a 4× Name
 * Size is name-bound, and a layout that measured only the box would let long
 * names land on their neighbours.
 */
export function layoutSpan(node: NodeSingular): Size {
  const box = baseBox(node);
  const plate = namePlate(node);
  return { w: Math.max(box.w, plate.w), h: Math.max(box.h, plate.h) };
}

/* ───────────────────────────────────────────────────────────────── the solve */

export interface ViewBudget {
  /** The OVERSIZE_TOLERANCE-th widest visible name, model units at factor 1. */
  labelCeiling: number;
  /** Visible elements that would draw a name. */
  labelled: number;
  /** Names this machine can draw per frame. Measured, not guessed. */
  budget: number;
}

export const EMPTY_BUDGET: ViewBudget = { labelCeiling: 0, labelled: 0, budget: 1500 };

export type ScaleLimit = 'none' | 'density' | 'skeleton' | 'ceiling' | 'texture';

/**
 * The rendered size, in pixels, of a *size-1* room's name at the zoom the two
 * views used to swap at. It is `FONT_MIN.location`, the size Cytoscape culls
 * that name at anyway — which is what made the old boundary *derived* rather
 * than chosen: names, room shapes and grouping titles all changed over together
 * because they had to.
 *
 * They no longer have to. The boundary is a setting now (below), and this
 * constant survives only to calibrate its default. The interesting consequence
 * is that lowering the threshold opens a band between the boundary and this
 * legibility point in which **rooms are drawn with no names** — which is the
 * whole point of making it adjustable, and costs nothing: Cytoscape's own
 * `min-zoomed-font-size`, seeded from `FONT_MIN`, culls each name at exactly
 * its own threshold, so big rooms keep their names longest and 1× rooms drop
 * out first. Raising it flips early instead, hiding names that were still
 * legible. Both are the user's call.
 */
export const SKELETON_NAME_PX = FONT_MIN.location;

/** The inverse of `thresholdZoom`. Used once: to calibrate the default. */
export function zoomThreshold(zoom: number, floor: number): number {
  const lo = Number.isFinite(floor) ? clamp(floor, MIN_ZOOM, MAX_ZOOM) : MIN_ZOOM;
  if (lo >= MAX_ZOOM) return 0;
  return clamp(Math.log(clamp(zoom, lo, MAX_ZOOM) / lo) / Math.log(MAX_ZOOM / lo), 0, 1);
}

/**
 * Where the views used to swap: a size-1 room's name is `NAME_FONT × zoom`
 * pixels tall at Name Size 1 with no compensation, and it was culled at
 * `SKELETON_NAME_PX` — so the boundary sat at zoom 0.5. On a map whose floor is
 * the nominal one, that is 45.4% of the way up the range, and *that* is the
 * default, so an untouched install behaves exactly as it always did.
 */
export const DEFAULT_SKELETON_THRESHOLD =
  Math.round(zoomThreshold(SKELETON_NAME_PX / NAME_FONT, DEFAULT_MIN_ZOOM) * 1000) / 1000;

/**
 * A position in the zoom range, as a zoom.
 *
 * Geometric, not linear: the range spans five decades, so a linear slider would
 * spend nine tenths of its travel inside a band nobody can ever reach.
 *
 *   t = 0 -> the floor itself, i.e. the skeleton is never entered
 *   t = 1 -> MAX_ZOOM, i.e. the skeleton is all there is
 */
export function thresholdZoom(threshold: number, floor: number): number {
  const lo = Number.isFinite(floor) ? clamp(floor, MIN_ZOOM, MAX_ZOOM) : MIN_ZOOM;
  const t = Number.isFinite(threshold) ? clamp(threshold, 0, 1) : DEFAULT_SKELETON_THRESHOLD;
  if (lo >= MAX_ZOOM) return MAX_ZOOM;
  return lo * Math.pow(MAX_ZOOM / lo, t);
}

/**
 * The zoom the two views swap at, given the floor the zoom bounds have settled
 * on. Feed it `cy.minZoom()`; the two cases agree by construction:
 *
 *   • skeleton allowed   — the floor *is* the fit floor, so the boundary sits
 *     `skeletonThreshold` of the way above it;
 *   • skeleton forbidden — `zoomBounds` has already *raised* the floor to meet
 *     the boundary, so the boundary is the floor, and nothing below it is
 *     reachable. Returning the floor therefore makes `skeletonAt` always false,
 *     which is exactly what that setting means.
 *
 * This is why nothing has to rebuild the extent model to ask where the boundary
 * is — and why `zoomBounds.zoomFloor`, the one function that is *computing*
 * `cy.minZoom()`, must call `thresholdZoom` directly instead of this.
 */
export function skeletonBoundary(floor: number, settings: Settings): number {
  return settings.allowSkeletonZoom ? thresholdZoom(settings.skeletonThreshold, floor) : floor;
}
/** A weight-1 connection's model width (see `weightToWidth(1)` in model.ts). */
const REFERENCE_LINE_WIDTH = 3.5;
/** The skeleton's centred grouping title is fitted to the grouping's own box,
 *  leaving exactly this fraction of the box as breathing room on each side —
 *  so the space the title gets is precisely as long and as tall as it needs. */
export const GROUP_NAME_INSET = 0.06;
export const GROUP_NAME_MIN_PX = 11;
export const GROUP_NAME_MAX_PX = 64;

const rungUp = (v: number) => (v <= 0 ? 0 : Math.pow(2, Math.ceil(Math.log2(v) / STEP) * STEP));

export interface ViewScale {
  /** Multiplies every text-like property. Boxes never scale at runtime. */
  text: number;
  /** Draw names at all. */
  labels: boolean;
  /** The far-zoom mode: names hidden, boxes faded, lines held readable,
   *  grouping titles take over as the map's landmarks. One flag drives all
   *  of it, so it cannot partially engage. */
  skeleton: boolean;
  /** Connection lines are drawn. False only inside a line-less skeleton. */
  lines: boolean;
  /** Multiplies every connection's line width. Exactly 1 outside the skeleton. */
  line: number;
  /** What pulled the factor back, for the status bar. */
  limit: ScaleLimit;
  /** The compensation factor before the texture ratio. */
  factor: number;
}

export const IDENTITY_SCALE: ViewScale = {
  text: 1,
  labels: true,
  skeleton: false,
  lines: true,
  line: 1,
  limit: 'none',
  factor: 1
};

export const scaleKey = (s: ViewScale) =>
  `${s.text}|${s.labels ? 1 : 0}|${s.skeleton ? 1 : 0}|${s.lines ? 1 : 0}|${s.line}`;

/** The compensation factor on names. Monotone in zoom, which `fitZoom` needs. */
export function textFactorAt(zoom: number, settings: Settings): number {
  if (!settings.constantSize) return 1;
  const s = clamp(settings.sizeCompensation, 0, 1);
  if (!s) return 1;
  return Math.min(MAX_COMPENSATION, Math.pow(clamp(zoom, MIN_ZOOM, MAX_ZOOM), -s));
}

/**
 * True exactly when the zoomed-out skeleton owns the canvas. Pure in `(zoom,
 * boundary)`: the same zoom always gives the same answer, in both directions.
 * There is still deliberately no hysteresis.
 */
export function skeletonAt(zoom: number, boundary: number): boolean {
  return clamp(zoom, MIN_ZOOM, MAX_ZOOM) < boundary;
}

/**
 * Compensation strength, eased toward 0 as the viewport fills with names.
 *
 * Holding names at a constant screen size is what *defeats* level-of-detail:
 * `min-zoomed-font-size` compares `fontSize × zoom`, which compensation holds
 * constant by construction, so nothing ever culls. The cure is to hand LOD
 * back exactly when it is needed — smoothly, in log space, so nothing snaps.
 */
function easedStrength(settings: Settings, b: ViewBudget) {
  const requested = settings.constantSize ? clamp(settings.sizeCompensation, 0, 1) : 0;
  if (!requested) return { s: 0, eased: false };
  const drawn = bucket(b.labelled);
  if (drawn <= b.budget) return { s: requested, eased: false };
  const hard = b.budget * 4;
  if (drawn >= hard) return { s: 0, eased: true };
  return { s: requested * (Math.log(hard / drawn) / Math.log(4)), eased: true };
}

export function solveViewScale(
  zoom: number,
  settings: Settings,
  b: ViewBudget,
  boundary: number
): ViewScale {
  const z = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
  const { s, eased } = easedStrength(settings, b);
  let limit: ScaleLimit = eased ? 'density' : 'none';

  let f = s <= 0 ? 1 : Math.pow(z, -s);
  if (f > 1) {
    if (f > MAX_COMPENSATION) {
      f = MAX_COMPENSATION;
      limit = 'ceiling';
    }
    f = rung(f);
  }

  /* label widths in element data are pre-multiplied by size × Name Size, so
     the rendered width is exactly labelCeiling × f × z */
  let ratio = 1;
  const drawn = b.labelCeiling * f * z;
  if (drawn > MAX_RENDERED_LABEL) {
    ratio = rungDown(MAX_RENDERED_LABEL / drawn);
    limit = 'texture';
  }
  const text = f * ratio;

  /* ── the skeleton transition ────────────────────────────────────────────
     One boolean drives names hiding, boxes fading, lines thickening and the
     grouping titles taking over, so the three can never drift apart by a
     frame. It is a pure function of the zoom, so the flip lands on exactly
     the same zoom whether the user is zooming in or out — `skeletonThreshold`
     is the single knob that moves it. */
  const skeleton = skeletonAt(z, boundary);

  /* ── names ────────────────────────────────────────────────────────────────
     Names are drawn exactly when the detailed view is. The skeleton *is* the
     no-names regime; the density cull that used to sit here was a second,
     invisible transition point — hysteretic, and keyed to a draw budget that
     collapses 10% per slow frame (which is what zooming out produces) and
     recovers at 2%. That is why the names stayed hidden octaves after the room
     shapes came back.

     Per-element culling is Cytoscape's `min-zoomed-font-size`, seeded from
     `FONT_MIN`. At the *default* threshold a size-1 room's cull point and the
     boundary coincide, so the two agree by construction. Below it they no
     longer do, and that gap is the feature: the rooms keep being drawn while
     their names cull themselves off one size at a time. Density pressure is
     answered by easing the compensation strength (`easedStrength`), which is
     precisely what hands that per-element culling back when it is needed. */
  const labels = !skeleton;

  /* The skeleton may be asked to drop the lines as well, leaving only the
     groupings: on a very large map that is the difference between drawing
     every connection and drawing a few dozen boxes. */
  const lines = !skeleton || settings.skeletonLines;

  /* a weight-1 line renders at exactly `skeletonLineWidth`; every other weight
     keeps its ratio to it; nothing already thicker is ever made thinner */
  const line =
    skeleton && lines
      ? Math.max(1, rungUp(settings.skeletonLineWidth / (REFERENCE_LINE_WIDTH * z)))
      : 1;

  if (skeleton) limit = 'skeleton';

  return { text, labels, skeleton, lines, line, limit, factor: f };
}
