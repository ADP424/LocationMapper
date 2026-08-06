import type { Core } from 'cytoscape';
import type { Settings } from '../state/settings';
import { MAX_ZOOM, MIN_ZOOM, textFactorAt } from './viewScale';

/** Groupings are padding around their children; `groupLayout` uses the same figure. */
const GROUP_PADDING = 34;

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  w: number;
  h: number;
}

/**
 * The drawn extent as an affine function of the *text* factor: `x2(f) = ax2 +
 * bx2·f`. Boxes are static now — only a compensated name plate can push past
 * a room's own edge — so each half-extent is `max(box/2, plate/2 · f)`, which
 * is convex in `f`. The chord through the exact extents at the two extreme
 * factors therefore encloses the truth and is exact at both ends: the same
 * argument the old box-compensated model relied on, just with one fewer
 * moving part.
 */
export interface ExtentModel {
  ax1: number;
  bx1: number;
  ax2: number;
  bx2: number;
  ay1: number;
  by1: number;
  ay2: number;
  by2: number;
}

export function drawnExtentAt(m: ExtentModel, f: number): Box {
  const x1 = m.ax1 + m.bx1 * f;
  const x2 = m.ax2 + m.bx2 * f;
  const y1 = m.ay1 + m.by1 * f;
  const y2 = m.ay2 + m.by2 * f;
  return { x1, y1, x2, y2, w: Math.max(1e-6, x2 - x1), h: Math.max(1e-6, y2 - y1) };
}

/* One model per canvas, invalidated by geometry, not by the viewport. The
   scrollbars, the zoom floor and Fit all read it — it used to be measured
   three times, with three full node-collection allocations. */
interface Cached {
  model: ExtentModel | null;
  dirty: boolean;
  settings: Settings | null;
}
const cache = new WeakMap<Core, Cached>();

export function invalidateExtent(cy: Core) {
  const c = cache.get(cy);
  if (c) c.dirty = true;
}

export function extentModel(cy: Core, settings: Settings): ExtentModel | null {
  let c = cache.get(cy);
  if (!c) cache.set(cy, (c = { model: null, dirty: true, settings: null }));
  if (!c.dirty && c.settings === settings) return c.model;
  c.model = compute(cy, settings);
  c.settings = settings;
  c.dirty = false;
  return c.model;
}

function compute(cy: Core, settings: Settings): ExtentModel | null {
  const fLo = textFactorAt(MAX_ZOOM, settings);
  const fHi = textFactorAt(MIN_ZOOM, settings);

  let lx1 = Infinity,
    ly1 = Infinity,
    lx2 = -Infinity,
    ly2 = -Infinity;
  let hx1 = Infinity,
    hy1 = Infinity,
    hx2 = -Infinity,
    hy2 = -Infinity;
  let hasGroup = false;

  cy.nodes().forEach((n) => {
    const d = n.data();
    if (d.kind === 'group') {
      hasGroup = true; // a grouping is its children plus padding, added below
      return;
    }
    if (typeof d.w !== 'number' || typeof d.h !== 'number') return;
    const p = n.position();
    const lw = typeof d.lw === 'number' ? d.lw : 0;
    const lh = typeof d.lh === 'number' ? d.lh : 0;

    /* the box is constant in f; the name plate scales with it — the
       half-extent max(box, plate·f) is convex in f, so the chord argument
       still encloses it exactly */
    const hwLo = Math.max(d.w, lw * fLo) / 2;
    const hhLo = Math.max(d.h, lh * fLo) / 2;
    const hwHi = Math.max(d.w, lw * fHi) / 2;
    const hhHi = Math.max(d.h, lh * fHi) / 2;

    if (p.x - hwLo < lx1) lx1 = p.x - hwLo;
    if (p.x + hwLo > lx2) lx2 = p.x + hwLo;
    if (p.y - hhLo < ly1) ly1 = p.y - hhLo;
    if (p.y + hhLo > ly2) ly2 = p.y + hhLo;

    if (p.x - hwHi < hx1) hx1 = p.x - hwHi;
    if (p.x + hwHi > hx2) hx2 = p.x + hwHi;
    if (p.y - hhHi < hy1) hy1 = p.y - hhHi;
    if (p.y + hhHi > hy2) hy2 = p.y + hhHi;
  });

  if (!Number.isFinite(lx1)) return null;

  if (hasGroup) {
    /* grouping padding is fixed model geometry — it never scales */
    lx1 -= GROUP_PADDING;
    lx2 += GROUP_PADDING;
    ly1 -= GROUP_PADDING;
    ly2 += GROUP_PADDING;
    hx1 -= GROUP_PADDING;
    hx2 += GROUP_PADDING;
    hy1 -= GROUP_PADDING;
    hy2 += GROUP_PADDING;
  }

  /* compensation off: the factor never moves, so the model is a constant */
  if (fHi - fLo < 1e-9) {
    return { ax1: lx1, bx1: 0, ax2: lx2, bx2: 0, ay1: ly1, by1: 0, ay2: ly2, by2: 0 };
  }

  const span = fHi - fLo;
  const bx1 = (hx1 - lx1) / span;
  const bx2 = (hx2 - lx2) / span;
  const by1 = (hy1 - ly1) / span;
  const by2 = (hy2 - ly2) / span;
  let ax1 = lx1 - bx1 * fLo;
  let ax2 = lx2 - bx2 * fLo;
  let ay1 = ly1 - by1 * fLo;
  let ay2 = ly2 - by2 * fLo;

  /* `renderedWidth(z) = (aW + bW·f(z))·z` is only monotone in z while aW ≥ 0.
     Raising the upper intercept only enlarges the model, so it stays conservative. */
  if (ax2 < ax1) ax2 = ax1;
  if (ay2 < ay1) ay2 = ay1;

  return { ax1, bx1, ax2, bx2, ay1, by1, ay2, by2 };
}

/**
 * The largest zoom at which the whole map is on screen.
 *
 * `rendered(z) = W(f(z))·z = aW·z + bW·z^(1−s)` is strictly increasing, so
 * "does it fit" is monotone and geometric bisection finds the boundary. There
 * is no closed form: at strength 1 the plate term is constant in rendered
 * pixels, and the fit exists at all only because `textFactorAt` saturates at
 * `MAX_COMPENSATION`.
 */
export function fitZoom(
  model: ExtentModel,
  usableW: number,
  usableH: number,
  settings: Settings,
  floor: number,
  ceiling: number
): number {
  const fits = (z: number) => {
    const b = drawnExtentAt(model, textFactorAt(z, settings));
    return b.w * z <= usableW && b.h * z <= usableH;
  };

  if (fits(ceiling)) return ceiling;
  let lo = floor;
  let hi = ceiling;
  if (!fits(lo)) return lo; // degenerate: nothing fits even fully zoomed out
  for (let i = 0; i < 48; i++) {
    const mid = Math.sqrt(lo * hi); // geometric: the range spans many decades
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}
