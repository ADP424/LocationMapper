import type { Core } from 'cytoscape';
import type { Settings } from '../state/settings';
import { viewScaleFactor } from './viewScale';

/** Groupings are padding around their children; `groupLayout` uses the same figure. */
const GROUP_PADDING = 34;

/* `viewScaleFactor` clamps the zoom to [0.01, 8] internally, so these bracket
   every factor the app can ever produce. */
const PROBE_IN = 8;
const PROBE_OUT = 1e-6;

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  w: number;
  h: number;
}

/**
 * The drawn extent of the map as an affine function of the compensation factor:
 * `x2(f) = ax2 + bx2·f`, and so on.
 *
 * Under compensation a node's drawn *model* size is `w·f`, so the extent is
 * `min/max` of lines in `f` — convex for the upper bounds, concave for the lower
 * ones. The chord through the exact extents at the two extreme factors therefore
 * **encloses** the true extent everywhere between and is exact at both ends: a
 * conservative model that costs one arithmetic pass and no `boundingBox()`.
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

/** One O(N) pass over positions and `data.w/h`. Never touches a Cytoscape cache. */
export function drawnExtentModel(
  cy: Core,
  baseScale: number,
  settings: Settings
): ExtentModel | null {
  const fLo = viewScaleFactor(PROBE_IN, settings);
  const fHi = viewScaleFactor(PROBE_OUT, settings);

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
    const hw = d.w / 2;
    const hh = d.h / 2;

    if (p.x - hw * fLo < lx1) lx1 = p.x - hw * fLo;
    if (p.x + hw * fLo > lx2) lx2 = p.x + hw * fLo;
    if (p.y - hh * fLo < ly1) ly1 = p.y - hh * fLo;
    if (p.y + hh * fLo > ly2) ly2 = p.y + hh * fLo;

    if (p.x - hw * fHi < hx1) hx1 = p.x - hw * fHi;
    if (p.x + hw * fHi > hx2) hx2 = p.x + hw * fHi;
    if (p.y - hh * fHi < hy1) hy1 = p.y - hh * fHi;
    if (p.y + hh * fHi > hy2) hy2 = p.y + hh * fHi;
  });

  if (!Number.isFinite(lx1)) return null;

  if (hasGroup) {
    /* the drawn grouping padding is `30 · baseScale · f`, so it scales too */
    const pad = GROUP_PADDING * Math.max(0.05, baseScale);
    lx1 -= pad * fLo;
    lx2 += pad * fLo;
    ly1 -= pad * fLo;
    ly2 += pad * fLo;
    hx1 -= pad * fHi;
    hx2 += pad * fHi;
    hy1 -= pad * fHi;
    hy2 += pad * fHi;
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
 * `rendered(z) = W(f(z))·z = aW·z + bW·z^(1−s)` is strictly increasing for any
 * compensation strength `s ∈ [0,1]`, so "does it fit" is monotone and a geometric
 * bisection finds the boundary. There is no closed-form ratio: at `s = 1` the box
 * term is constant in rendered pixels, and the fit only exists at all because
 * `viewScaleFactor` saturates the factor below `zoom = 0.01`.
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
    const b = drawnExtentAt(model, viewScaleFactor(z, settings));
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
