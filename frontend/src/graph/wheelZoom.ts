import type { Core } from 'cytoscape';

/**
 * Wheel zooming, owned by the app.
 *
 * Cytoscape's wheel zoom can only be tuned through the `wheelSensitivity`
 * *construction* option. Changing it later means writing to a private renderer
 * field that is re-seeded from that option, so the setting silently reverted to
 * the library default depending on startup ordering. There is no way to read
 * the value back, so there is no way to make that approach reliable.
 *
 * Instead the wheel is intercepted in the capture phase on an element *above*
 * Cytoscape's container: stopping it there means the library's handler never
 * runs, and the zoom step is computed here from values we control. Touch
 * gestures are left alone, so pinch zoom still works.
 *
 * The curve is NOT Cytoscape's own (`delta/250`, `*33` for line-mode events) —
 * that combination turns out to be extremely aggressive: at the app's default
 * sensitivity (0.85) a single ordinary mouse notch (~100px) already zooms
 * ~2.2x, and a line-mode browser (Firefox, some trackpads) reporting a couple
 * of lines per event compounds that further, into a 4x+ jump from one flick of
 * the wheel. `ZOOM_DIVISOR` below is retuned so one notch is a gentle, precise
 * ~1.05x at the default sensitivity, and pixel/line/page-reporting browsers all
 * feel the same.
 */

/* One wheel notch is ~100px in pixel mode and ~3 lines in line mode, so a line
   is ~33px; browsers that report pages are treated as ten lines. */
const PIXELS_PER_LINE = 33;
const PIXELS_PER_PAGE = 330;

/** Rogue drivers and momentum bursts can emit enormous single deltas. */
const MAX_DELTA = 400;

/** Tuned so one ~100px notch is ~1.05x zoom at the default sensitivity (0.85). */
const ZOOM_DIVISOR = 4292;

function pixelDelta(e: WheelEvent): number {
  const perUnit = e.deltaMode === 1 ? PIXELS_PER_LINE : e.deltaMode === 2 ? PIXELS_PER_PAGE : 1;
  const delta = e.deltaY * perUnit;
  return Math.max(-MAX_DELTA, Math.min(MAX_DELTA, delta));
}

export interface WheelZoomOptions {
  /** Read per event, so the Settings slider applies live. */
  sensitivity: () => number;
  /** Skip zooming, e.g. mid-marquee or while dragging a room. */
  blocked?: () => boolean;
}

/**
 * @param interceptor an element *above* the Cytoscape container
 * @returns an unbind function
 */
export function bindWheelZoom(interceptor: HTMLElement, cy: Core, opts: WheelZoomOptions) {
  const onWheel = (event: WheelEvent) => {
    /* Cytoscape binds `wheel` on its own container; stopping the event up here
       in the capture phase means its handler never sees it. */
    event.stopPropagation();
    event.preventDefault();

    if (opts.blocked?.() || !cy.zoomingEnabled()) return;

    const delta = pixelDelta(event);
    if (!delta) return;

    const current = cy.zoom();
    const level = current * Math.pow(10, (-delta / ZOOM_DIVISOR) * opts.sensitivity());
    if (!Number.isFinite(level) || level <= 0) return;

    /* `cy.zoom` clamps into the zoom range, and the floor moves with the map —
       never let that clamp yank the view back in when we are already outside it */
    if (level < current && current <= cy.minZoom()) return;
    if (level > current && current >= cy.maxZoom()) return;

    /* zoom about the cursor, in the container's own rendered coordinates */
    const rect = (cy.container() ?? interceptor).getBoundingClientRect();
    cy.zoom({
      level,
      renderedPosition: { x: event.clientX - rect.left, y: event.clientY - rect.top }
    });
  };

  interceptor.addEventListener('wheel', onWheel, { capture: true, passive: false });
  return () => interceptor.removeEventListener('wheel', onWheel, true);
}
