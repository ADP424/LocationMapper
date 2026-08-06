import type { NodeSingular } from 'cytoscape';
import type { Settings } from '../state/settings';

/* ─────────────────────────────────────────────────────────── the zoom range */

export const MIN_ZOOM = 2e-4;
export const MAX_ZOOM = 8;

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

/** A location name below this many rendered pixels is not worth drawing —
 *  the skeleton's readability trigger, checked against a *size-1* room so
 *  Base Size and compensation alone decide it, never an individual room's
 *  own size scalar. */
export const NAME_MIN_PX = 6;
/** Leaving the skeleton costs 15% more zoom than entering it — matches the
 *  density hysteresis below, so neither rule can strobe on its own. */
const SKELETON_HYSTERESIS = 1.15;
/** A weight-1 connection's model width (see `weightToWidth(1)` in model.ts). */
const REFERENCE_LINE_WIDTH = 3.5;

/** How much of a grouping's own box its centred skeleton title may fill. */
export const GROUP_NAME_FIT_W = 0.8;
export const GROUP_NAME_FIT_H = 0.55;
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
  line: 1,
  limit: 'none',
  factor: 1
};

export const scaleKey = (s: ViewScale) =>
  `${s.text}|${s.labels ? 1 : 0}|${s.skeleton ? 1 : 0}|${s.line}`;

/** The compensation factor on names. Monotone in zoom, which `fitZoom` needs. */
export function textFactorAt(zoom: number, settings: Settings): number {
  if (!settings.constantSize) return 1;
  const s = clamp(settings.sizeCompensation, 0, 1);
  if (!s) return 1;
  return Math.min(MAX_COMPENSATION, Math.pow(clamp(zoom, MIN_ZOOM, MAX_ZOOM), -s));
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
  previous: ViewScale = IDENTITY_SCALE
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

  /* 15% hysteresis, or a map sitting on the threshold would strobe */
  const labels = previous.labels ? b.labelled <= b.budget * 1.15 : b.labelled <= b.budget * 0.85;
  if (!labels && limit === 'none') limit = 'density';

  /* ── the skeleton transition ──────────────────────────────────────────
     One boolean drives everything below it: names hiding, boxes fading and
     lines thickening all read this same flag out of the same solved scale,
     so they land in the same batched write and cannot drift apart by a
     frame. It fires on either of two independent, hysteretic conditions:
     a size-1 room's name has become too small to read, or there are simply
     too many names to draw at all (the existing density rule). */
  const refFont = NAME_FONT * settings.baseScale * text * z;
  const tooSmall = previous.skeleton ? refFont < NAME_MIN_PX * SKELETON_HYSTERESIS : refFont < NAME_MIN_PX;
  const skeleton = settings.skeletonView && (tooSmall || !labels);

  /* a weight-1 line renders at exactly `skeletonLineWidth`; every other
     weight keeps its ratio to it; nothing already thicker than the floor is
     ever made thinner, so the transition never looks like a glitch */
  const line = skeleton
    ? Math.max(1, rungUp(settings.skeletonLineWidth / (REFERENCE_LINE_WIDTH * z)))
    : 1;

  /* the skeleton is a strictly more specific state than the plain density
     cull that can itself trigger it — it should always win the status chip */
  if (skeleton) limit = 'skeleton';

  return { text, labels: labels && !skeleton, skeleton, line, limit, factor: f };
}
