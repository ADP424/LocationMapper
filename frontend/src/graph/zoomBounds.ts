import type { Core } from 'cytoscape';
import type { Settings } from '../state/settings';
import { drawnExtentAt, extentModel, fitZoom } from './extent';
import { DEFAULT_MIN_ZOOM, MAX_ZOOM, MIN_ZOOM, textFactorAt, thresholdZoom } from './viewScale';

export { MAX_ZOOM, MIN_ZOOM, DEFAULT_MIN_ZOOM };

export const FIT_PADDING = 60;

/** Let the user pull back a little past a perfect fit. */
const FIT_SLACK = 0.75;
/** …and wander at most this many viewports past the content. */
const PAN_SLACK = 1;

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
 * The lowest zoom the user may reach.
 *
 * Normally that is "the whole map on screen, plus a little slack". With
 * `allowSkeletonZoom` off it is the skeleton boundary instead: the far-out view
 * is the one that puts *every* element on screen at once, so refusing to enter
 * it is the strongest performance guard the app has. It belongs here, which is
 * the single place the floor is ever set, rather than in the wheel handler —
 * so a re-layout, a Fit, a map open and a settings change all honour it without
 * knowing it exists.
 */
function zoomFloor(cy: Core, settings: Settings): number {
  const solved = solve(cy, settings, FIT_PADDING);
  const fit = solved
    ? Math.max(MIN_ZOOM, Math.min(DEFAULT_MIN_ZOOM, solved.zoom * FIT_SLACK))
    : DEFAULT_MIN_ZOOM;
  if (settings.allowSkeletonZoom) return fit;
  /* Refusing to enter the skeleton means its boundary *is* the floor. Computed
     from `fit`, never from `skeletonBoundary(cy.minZoom(), …)`: `cy.minZoom()`
     is the very value this function is about to set, and feeding it back in
     would make the floor chase itself upward on every sync. */
  return Math.min(MAX_ZOOM, Math.max(fit, thresholdZoom(settings.skeletonThreshold, fit)));
}

/** Only ever *lowered* below `DEFAULT_MIN_ZOOM` — unless the skeleton is
 *  forbidden, in which case the floor is raised to its boundary.
 *
 * Called from exactly one place — `syncGeometry` — which is why there is no
 * throttle here any more: it used to run on every reconcile, i.e. every click.
 */
export function refreshMinZoom(cy: Core, settings: Settings) {
  const min = zoomFloor(cy, settings);
  if (Math.abs(min - cy.minZoom()) > min * 0.01) cy.minZoom(min);
}

/** `cy.minZoom()` declares a bound; it does not enforce it. A layout that shrank
 *  the map leaves the viewport standing below the new floor until something else
 *  happens to call `cy.zoom()`. */
export function clampZoom(cy: Core) {
  const min = cy.minZoom();
  if (cy.zoom() >= min) return;
  cy.zoom({ level: min, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
}

/**
 * Frame the whole map. This replaces `cy.fit()`, which measures drawn geometry —
 * now deliberately clamped and, off-screen, deliberately stale — and which assumes
 * the content shrinks linearly with the zoom, which it does not under compensation.
 *
 * The zoom floor is already correct when this runs: `syncGeometry` refreshes it
 * one step earlier, against the same freshly-built extent model.
 */
export function fitToContent(cy: Core, settings: Settings, padding = FIT_PADDING) {
  const solved = solve(cy, settings, padding);
  if (!solved) return;

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
 *
 * Two callers, deliberately: `syncGeometry` (the content moved under the
 * viewport) and the live `viewport` handler (the viewport moved over the
 * content). Neither is a "reset".
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
