/**
 * The device-pixel contract for every canvas this app paints *over* the
 * Cytoscape viewport.
 *
 * Two traps live here, and both of them are invisible at `devicePixelRatio: 1`:
 *
 *   1. A `<canvas>` is a **replaced** element. Give it `position:absolute;
 *      inset:0` and no width, and CSS resolves its box to its *intrinsic* size
 *      — the `width`/`height` attributes, read as CSS pixels — and throws away
 *      `right`/`bottom` as over-constrained. Size the backing store to
 *      `css × dpr` and the element silently becomes `dpr` times too big. Every
 *      overlay must therefore be given an explicit CSS size (see styles.css).
 *
 *   2. `devicePixelRatio` is *not* the ratio the browser displays the backing
 *      store at. The store is an integer number of pixels; the box is a
 *      fractional number of CSS pixels. The real ratio is the quotient of the
 *      two, and it differs per axis. Transform by that, never by the nominal
 *      ratio, and the overlay lands on the same physical pixel Cytoscape put
 *      its nodes on — at any resolution, any OS scaling, any browser zoom.
 *
 * Nothing here knows about React or Cytoscape.
 */

export interface OverlayView {
  /** The painted box in CSS pixels — fractional, exactly as laid out. */
  cssW: number;
  cssH: number;
  /** Device pixels per CSS pixel, *measured*. Never `devicePixelRatio`. */
  sx: number;
  sy: number;
}

/** Size the backing store to the canvas's real box; report how it will be shown. */
export function measureOverlay(canvas: HTMLCanvasElement): OverlayView | null {
  const rect = canvas.getBoundingClientRect();
  const cssW = rect.width;
  const cssH = rect.height;
  if (!(cssW > 0) || !(cssH > 0)) return null;

  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(cssW * dpr));
  const h = Math.max(1, Math.round(cssH * dpr));
  /* assigning clears the canvas, so only do it when it really changed */
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;

  return { cssW, cssH, sx: w / cssW, sy: h / cssH };
}

/** Model space -> device pixels, landing on the same CSS pixels Cytoscape used. */
export function applyViewTransform(
  ctx: CanvasRenderingContext2D,
  view: OverlayView,
  zoom: number,
  pan: { x: number; y: number }
) {
  ctx.setTransform(view.sx * zoom, 0, 0, view.sy * zoom, view.sx * pan.x, view.sy * pan.y);
}

/** CSS pixels -> device pixels, for overlays that draw in screen space. */
export function applyCssTransform(ctx: CanvasRenderingContext2D, view: OverlayView) {
  ctx.setTransform(view.sx, 0, 0, view.sy, 0, 0);
}

/**
 * Dragging a window from a 4K panel onto a 1080p one changes the ratio and
 * resizes nothing, so `ResizeObserver` never fires. A media query on the
 * current ratio is the only event the platform offers; it has to be re-armed at
 * the new ratio every time it trips.
 */
export function watchDevicePixelRatio(onChange: () => void): () => void {
  let disposed = false;
  let mq: MediaQueryList | null = null;

  const handler = () => {
    if (disposed) return;
    arm();
    onChange();
  };
  const arm = () => {
    mq?.removeEventListener('change', handler);
    const dpr = window.devicePixelRatio || 1;
    try {
      mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
      mq.addEventListener('change', handler);
    } catch {
      mq = null; // no `resolution` support: the resize backstop below covers it
    }
  };

  arm();
  return () => {
    disposed = true;
    mq?.removeEventListener('change', handler);
  };
}

export interface OverlaySurface {
  /** Measured and cached; recomputed only when the box or the ratio changed. */
  view: () => OverlayView | null;
  destroy: () => void;
}

/**
 * A correctly sized overlay canvas. The measurement is cached because
 * `getBoundingClientRect` forces a layout flush, and this is read every frame;
 * it is invalidated by the only two things that can move it — the box resizing,
 * and the device pixel ratio changing.
 */
export function createOverlaySurface(
  canvas: HTMLCanvasElement,
  onInvalidate: () => void
): OverlaySurface {
  let view: OverlayView | null = null;
  let dirty = true;

  const invalidate = () => {
    dirty = true;
    onInvalidate();
  };

  const ro = new ResizeObserver(invalidate);
  ro.observe(canvas);
  const offRatio = watchDevicePixelRatio(invalidate);
  /* belt and braces for browsers without the `resolution` media query: an OS
     scaling change or a monitor hop nearly always comes with a window resize */
  window.addEventListener('resize', invalidate);

  return {
    view() {
      if (dirty) {
        view = measureOverlay(canvas);
        dirty = false;
      }
      return view;
    },
    destroy() {
      ro.disconnect();
      offRatio();
      window.removeEventListener('resize', invalidate);
    }
  };
}
