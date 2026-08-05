import type { Core } from 'cytoscape';
import type { Settings } from '../state/settings';
import { drawnExtentAt, drawnExtentModel, fitZoom } from './extent';
import { viewScaleFactor } from './viewScale';

export const DEFAULT_MIN_ZOOM = 0.04;
export const MAX_ZOOM = 4;
export const FIT_PADDING = 60;

/** Let the user pull back a little past a perfect fit. */
const FIT_SLACK = 0.75;
const HARD_FLOOR = 1e-7;

const THROTTLE_MS = 250;
const lastRun = new WeakMap<Core, number>();

function solve(cy: Core, settings: Settings, padding: number) {
  const model = drawnExtentModel(cy, settings.baseScale, settings);
  if (!model) return null;
  const usableW = Math.max(1, cy.width() - padding * 2);
  const usableH = Math.max(1, cy.height() - padding * 2);
  /* the render ceilings only ever *shrink* drawn geometry, so a fit solved
     without them is conservative: everything still fits */
  return { model, zoom: fitZoom(model, usableW, usableH, settings, HARD_FLOOR, MAX_ZOOM) };
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
    ? Math.max(HARD_FLOOR, Math.min(DEFAULT_MIN_ZOOM, solved.zoom * FIT_SLACK))
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
  const box = drawnExtentAt(solved.model, viewScaleFactor(zoom, settings));
  const cx = (box.x1 + box.x2) / 2;
  const cyy = (box.y1 + box.y2) / 2;
  cy.viewport({
    zoom,
    pan: { x: cy.width() / 2 - cx * zoom, y: cy.height() / 2 - cyy * zoom }
  });
}
