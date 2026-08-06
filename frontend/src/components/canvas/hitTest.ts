import type { Core, NodeSingular } from 'cytoscape';
import { baseBox, namePlate } from '../../graph/viewScale';
import type { CanvasHandle } from './handle';

/** How far outside the room the drag handle floats, so it never overlaps it. */
export const HANDLE_OFFSET = 18;

/** Boxes are static, so position ± w/2 *is* the drawn box — no `boundingBox()`,
 *  which forces a bounds recalc and, off-screen, reads stale data. */
export function boxOf(n: NodeSingular) {
  const p = n.position();
  const { w, h } = baseBox(n);
  return { x1: p.x - w / 2, x2: p.x + w / 2, y1: p.y - h / 2, y2: p.y + h / 2, w, h };
}

export function locationAt(cy: Core, pos: { x: number; y: number }): NodeSingular | null {
  let best: NodeSingular | null = null;
  let bestArea = Infinity;
  cy.nodes('.location').forEach((n) => {
    const bb = boxOf(n);
    if (pos.x < bb.x1 || pos.x > bb.x2 || pos.y < bb.y1 || pos.y > bb.y2) return;
    const area = bb.w * bb.h;
    if (area < bestArea) {
      bestArea = area;
      best = n;
    }
  });
  return best;
}

export function nearestLocation(cy: Core, pos: { x: number; y: number }, maxDist: number) {
  let best: NodeSingular | null = null;
  let bestDist = Infinity;
  cy.nodes('.location').forEach((n) => {
    const bb = boxOf(n);
    const dx = Math.max(bb.x1 - pos.x, 0, pos.x - bb.x2);
    const dy = Math.max(bb.y1 - pos.y, 0, pos.y - bb.y2);
    const d = Math.hypot(dx, dy);
    if (d < bestDist) {
      bestDist = d;
      best = n;
    }
  });
  return bestDist <= maxDist ? best : null;
}

/** Push a point away from a centre so the handle floats just outside the room. */
export function pushOut(point: { x: number; y: number }, from: { x: number; y: number }) {
  const dx = point.x - from.x;
  const dy = point.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: point.x + (dx / len) * HANDLE_OFFSET, y: point.y + (dy / len) * HANDLE_OFFSET };
}

export const renderedToModel = (cy: Core, x: number, y: number) => ({
  x: (x - cy.pan().x) / cy.zoom(),
  y: (y - cy.pan().y) / cy.zoom()
});

/**
 * What is *really* under this point — a room's box, a room's name plate, or an
 * ephemeral stub's box/plate — smallest footprint first. Used when Cytoscape
 * reports a grouping as the tap target: a grouping may only win a click when
 * nothing else is under the cursor, since its box is background, not a lid.
 * Bounding boxes (not shape paths) are deliberate: the dead corner of a
 * diamond still belongs to the diamond, not to the grouping behind it.
 *
 * The plate is only a target while it is actually drawn: `namePlate()` already
 * carries `size × Base Size`, so at compensation 1 the box in view is exactly
 * `plate.w/h * scale.text` when the ViewScaler is holding names larger than
 * their build-time size, and `scale.labels` gates it off entirely once names
 * are culled.
 */
export function resolveLocationHit(handle: CanvasHandle, pos: { x: number; y: number }): NodeSingular | null {
  const { cy, scaler } = handle;
  const { text, labels } = scaler.currentScale;
  let best: NodeSingular | null = null;
  let bestArea = Infinity;
  cy.nodes('.location, .portal').forEach((n) => {
    const p = n.position();
    const box = baseBox(n);
    const plate = namePlate(n);
    const pw = labels ? plate.w * text : 0;
    const ph = labels ? plate.h * text : 0;
    const hw = Math.max(box.w, pw) / 2;
    const hh = Math.max(box.h, ph) / 2;
    if (Math.abs(pos.x - p.x) > hw || Math.abs(pos.y - p.y) > hh) return;
    const area = hw * hh;
    if (area < bestArea) {
      bestArea = area;
      best = n as unknown as NodeSingular;
    }
  });
  return best;
}
