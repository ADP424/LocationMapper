import type { Core } from 'cytoscape';
import type { Settings } from '../state/settings';
import {
  PLANE_AXES,
  coordToModel,
  modelToCoord,
  type Axis,
  type CoordinateFrame
} from './coordinateLayout';
import { skeletonAt } from './viewScale';

/**
 * Level of detail for the coordinate lattice.
 *
 * The rule is not "zoomed out ⇒ every fifth line"; it is **keep the on-screen
 * gap inside a legible band**, which *produces* every-1 up close and
 * every-5/10/50 far away, continuously and one rung at a time. A 1-2-5 ladder
 * is the standard for exactly this, and every rung is an integer, which
 * coordinates have to be.
 *
 * Numbers follow the same idea one band wider: every line when each line has
 * room for one, otherwise every major line. Because `labelStride` is always
 * either `stride` or `stride × MAJOR_EVERY`, a number always lands on a line
 * that is actually drawn.
 */
const MIN_LINE_PX = 26;
const MIN_LABEL_PX = 56;
/** A brighter line every N minor steps, so a coarse grid stays countable. */
const MAJOR_EVERY = 5;
/** Paranoia: a nonsense unit must never try to emit a million lines. */
const MAX_LINES = 400;

const LADDER = [1, 2, 5];

/** Smallest ladder rung whose on-screen gap clears `minPx`. Never below 1. */
function strideFor(screenStep: number, minPx: number): number {
  if (!(screenStep > 0)) return 1;
  if (screenStep >= minPx) return 1;
  let decade = 1;
  for (let i = 0; i < 14; i++) {
    for (const m of LADDER) {
      const s = m * decade;
      if (s * screenStep >= minPx) return s;
    }
    decade *= 10;
  }
  return decade;
}

export interface GridLine {
  /** The integer coordinate this line stands for. */
  coord: number;
  /** Where it lands along its axis, in CSS pixels. */
  px: number;
  major: boolean;
  /** Coordinate zero — the lattice's own axis. */
  axis: boolean;
  label: boolean;
}

export interface GridSolution {
  /** Vertical lines: constant horizontal coordinate. */
  cols: GridLine[];
  /** Horizontal lines: constant vertical coordinate. */
  rows: GridLine[];
  stride: number;
  axes: { h: Axis; v: Axis };
  skeleton: boolean;
  /** Numbers are drawn at all — never in the zoomed-out skeleton. */
  labels: boolean;
}

function axisLines(
  lo: number,
  hi: number,
  stride: number,
  major: number,
  labelStride: number,
  toPx: (coord: number) => number
): GridLine[] | null {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  const first = Math.floor(lo / stride) * stride;
  const last = Math.ceil(hi / stride) * stride;
  const count = (last - first) / stride;
  if (!Number.isFinite(count) || count < 0 || count > MAX_LINES) return null;
  const out: GridLine[] = [];
  for (let c = first; c <= last; c += stride) {
    out.push({
      coord: c,
      px: toPx(c),
      /* -0 % n is -0, which compares equal to 0 — negative coordinates are fine */
      major: c % major === 0,
      axis: c === 0,
      label: c % labelStride === 0
    });
  }
  return out;
}

/** Every line the current viewport should show, already in CSS pixels. */
export function solveGrid(
  cy: Core,
  frame: CoordinateFrame,
  settings: Settings
): GridSolution | null {
  const unit = frame.unit;
  if (!Number.isFinite(unit) || unit <= 0) return null;

  const zoom = cy.zoom();
  const pan = cy.pan();
  const screenStep = unit * zoom;
  if (!Number.isFinite(screenStep) || screenStep <= 0) return null;

  const skeleton = skeletonAt(zoom, settings);
  const stride = strideFor(screenStep, MIN_LINE_PX);
  const major = stride * MAJOR_EVERY;
  const labelStride = stride * screenStep >= MIN_LABEL_PX ? stride : major;

  const ext = cy.extent();
  const a = modelToCoord(ext.x1, ext.y1, unit);
  const b = modelToCoord(ext.x2, ext.y2, unit);

  const cols = axisLines(
    Math.min(a.h, b.h),
    Math.max(a.h, b.h),
    stride,
    major,
    labelStride,
    (c) => coordToModel(c, 0, unit).x * zoom + pan.x
  );
  const rows = axisLines(
    Math.min(a.v, b.v),
    Math.max(a.v, b.v),
    stride,
    major,
    labelStride,
    (c) => coordToModel(0, c, unit).y * zoom + pan.y
  );
  if (!cols || !rows) return null;

  return { cols, rows, stride, axes: PLANE_AXES[frame.plane], skeleton, labels: !skeleton };
}
