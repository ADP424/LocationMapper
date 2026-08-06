import type { Core } from 'cytoscape';
import type { Settings } from '../state/settings';
import { drawnExtentAt, extentModel, fitZoom } from './extent';
import { MAX_ZOOM, MIN_ZOOM, textFactorAt } from './viewScale';

export { MAX_ZOOM, MIN_ZOOM };
export const DEFAULT_MIN_ZOOM = 0.05;
export const FIT_PADDING = 60;

/** Let the user pull back a little past a perfect fit. */
const FIT_SLACK = 0.75;
/** …and wander at most this many viewports past the content. */
const PAN_SLACK = 1;
const THROTTLE_MS = 150;

const lastRun = new WeakMap<Core, number>();

function solve(cy: Core, settings: Settings, padding: number) {
  const model = extentModel(cy, settings);
  if (!model) return null;
  const usableW = Math.max(1, cy.width() - padding * 2);
  const usableH = Math.max(1, cy.height() - padding * 2);
  /* the render ceilings only ever *shrink* drawn geometry, so a fit solved
     without them is conservative: everything still fits */
  return { model, zoom: fitZoom(model, usableW, usableH, settings, MIN_ZOOM, MAX_ZOOM) };
}

/**
 * Let the user zoom out until the whole map is on screen, however far apart the
 * rooms are — and however much the compensation is holding the boxes open. The
 * floor is only ever *lowered* below `DEFAULT_MIN_ZOOM`.
 */
export function refreshMinZoom(cy: Core, settings: Settings, force = false) {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (!force && now - (lastRun.get(cy) ?? -Infinity) < THROTTLE_MS) return;
  lastRun.set(cy, now);

  const solved = solve(cy, settings, FIT_PADDING);
  const min = solved
    ? Math.max(MIN_ZOOM, Math.min(DEFAULT_MIN_ZOOM, solved.zoom * FIT_SLACK))
    : DEFAULT_MIN_ZOOM;

  if (Math.abs(min - cy.minZoom()) > min * 0.01) cy.minZoom(min);
}

/**
 * Frame the whole map. This replaces `cy.fit()`, which measures drawn geometry —
 * now deliberately clamped and, off-screen, deliberately stale — and which assumes
 * the content shrinks linearly with the zoom, which it does not under compensation.
 */
export function fitToContent(cy: Core, settings: Settings, padding = FIT_PADDING) {
  const solved = solve(cy, settings, padding);
  if (!solved) return;

  refreshMinZoom(cy, settings, true);
  const zoom = Math.min(Math.max(solved.zoom, cy.minZoom()), cy.maxZoom());

  /* centre on the extent at the factor that zoom actually produces */
  const box = drawnExtentAt(solved.model, textFactorAt(zoom, settings));
  const cx = (box.x1 + box.x2) / 2;
  const cyy = (box.y1 + box.y2) / 2;
  cy.viewport({
    zoom,
    pan: { x: cy.width() / 2 - cx * zoom, y: cy.height() / 2 - cyy * zoom }
  });
}

/**
 * Keep the viewport within a viewport's width of the content. A user who has
 * panned a 60 000-px map into empty space has, in effect, lost their map.
 */
export function clampPan(cy: Core, settings: Settings) {
  const model = extentModel(cy, settings);
  if (!model) return;
  const z = cy.zoom();
  const box = drawnExtentAt(model, textFactorAt(z, settings));
  const e = cy.extent();
  const padX = e.w * PAN_SLACK;
  const padY = e.h * PAN_SLACK;

  const minX = box.x1 - padX;
  const maxX = box.x2 + padX;
  const minY = box.y1 - padY;
  const maxY = box.y2 + padY;

  let x = e.x1;
  let y = e.y1;
  if (e.w >= maxX - minX) x = (minX + maxX - e.w) / 2;
  else x = Math.min(Math.max(x, minX), maxX - e.w);
  if (e.h >= maxY - minY) y = (minY + maxY - e.h) / 2;
  else y = Math.min(Math.max(y, minY), maxY - e.h);

  if (Math.abs(x - e.x1) > 0.5 || Math.abs(y - e.y1) > 0.5) {
    cy.pan({ x: -x * z, y: -y * z });
  }
}
