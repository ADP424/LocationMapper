import type { NodeSingular } from 'cytoscape';
import { useEffect, useRef } from 'react';
import { bodyBounds, hitGroupBody, type GroupBody } from '../../graph/groupRegions';
import type { Pt } from '../../graph/groupShape';
import { PALETTE } from '../../graph/model';
import type { CanvasHandle } from './handle';

/**
 * Paints the body of *every* grouping — rectangles included, now that multiple
 * memberships mean two bodies routinely overlap and a Cytoscape-painted
 * rectangle would always win the stack regardless of `zLayer`. The bodies
 * themselves — geometry, titles — are owned by `handle.groupBodies` (see
 * `graph/groupRegions.ts`); this component is a consumer, not an owner:
 * `GroupShapeLayer` only paints what the store last solved, and marks it dirty
 * when the shape can have changed.
 *
 * Cytoscape's compound parents can only be simple shapes, so every body is
 * painted on a canvas that sits *behind* Cytoscape's own (transparent) canvases,
 * by DOM order alone. The compound node itself keeps only its title, its
 * classes and (for an anchored room) containment; none of its box is painted —
 * suppressed unconditionally by `style.ts`.
 *
 * And because the node's own rectangle is never drawn, it must no longer be
 * *hit* either. Cytoscape skips any element whose computed `events` is `no`, so
 * a capture-phase pointer listener on the wrapper — which runs before Cytoscape's
 * own handlers on the container — sets a `bodyHit` flag from a real
 * point-in-region test. Exactly one grouping is eligible under the cursor: the
 * topmost body whose region contains the point, drawn bottom-up and hit
 * top-down. Selection, dragging, drop targets, the context menu and the
 * marquee then all inherit the correct hit area without knowing any of this.
 *
 * Geometry is recomputed only when it can have changed; the paint runs on
 * Cytoscape's `render` event, so it shares the renderer's cadence and its exact
 * pan/zoom — there is no frame in which the two disagree.
 */
export default function GroupShapeLayer({ handle }: { handle: CanvasHandle | null }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /* one reused offscreen buffer; the snake needs it, the outline does not */
  const offRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrapper = canvas?.parentElement;
    if (!handle || !canvas || !wrapper) return;
    const { cy } = handle;
    const container = cy.container();

    const markDirty = () => handle.groupBodies.markDirty();
    const bodies = () => handle.groupBodies.get();

    /* ------------------------------------------------------------ hit area */

    const setHit = (node: NodeSingular, on: boolean) => {
      const want = on ? 1 : 0;
      if (node.data('bodyHit') !== want) node.data('bodyHit', want);
    };

    const updateHitAreas = (clientX: number, clientY: number) => {
      if (!container || cy.destroyed()) return;
      const box = container.getBoundingClientRect();
      const zoom = cy.zoom();
      const pan = cy.pan();
      const p: Pt = {
        x: (clientX - box.left - pan.x) / zoom,
        y: (clientY - box.top - pan.y) / zoom
      };
      /* drawn bottom-up (`bodies()` is zLayer-ascending); hit top-down, so the
         first match walking backwards is the topmost body under the cursor —
         exactly one grouping wins the point, whatever else it overlaps */
      const list = bodies();
      let winner: string | null = null;
      for (let i = list.length - 1; i >= 0; i--) {
        if (hitGroupBody(list[i], p)) {
          winner = list[i].nodeId;
          break;
        }
      }
      const hasBody = new Set(list.map((b) => b.nodeId));
      cy.nodes('.group').forEach((node) => {
        /* every grouping has a body now (rectangles included); an undrawn
           grouping (nothing renderable in its subtree) has none at all */
        setHit(node, hasBody.has(node.id()) ? node.id() === winner : false);
      });
    };

    /* capture on the wrapper, so this lands before Cytoscape's listeners on the
       container and its hit test sees the flag we just wrote. A drag or a pan is
       already committed to its target, and re-deciding mid-gesture would drop it. */
    const onPointerMove = (e: PointerEvent) => {
      if (e.buttons !== 0 || cy.nodes(':grabbed').nonempty()) return;
      updateHitAreas(e.clientX, e.clientY);
    };
    const onPointerDown = (e: PointerEvent) => updateHitAreas(e.clientX, e.clientY);

    wrapper.addEventListener('pointermove', onPointerMove, true);
    wrapper.addEventListener('pointerdown', onPointerDown, true);

    /* ------------------------------------------------------------- painting */

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(wrapper.clientWidth * dpr));
      const h = Math.max(1, Math.round(wrapper.clientHeight * dpr));
      if (canvas.width === w && canvas.height === h) return;
      canvas.width = w;
      canvas.height = h;
      if (offRef.current) {
        offRef.current.width = w;
        offRef.current.height = h;
      }
    };

    const draw = () => {
      if (cy.destroyed()) return;
      resize();
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const list = bodies();
      if (!list.length) return;

      const zoom = cy.zoom();
      const pan = cy.pan();
      const view = (c: CanvasRenderingContext2D) =>
        c.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * pan.x, dpr * pan.y);
      const toDevice = (x: number, y: number): Pt => ({
        x: (x * zoom + pan.x) * dpr,
        y: (y * zoom + pan.y) * dpr
      });

      for (const body of list) {
        const paint = paintOf(body);
        if (paint.alpha <= 0) continue;
        if (body.style === 'rectangle') drawRect(ctx, body, paint, view);
        else if (body.loop) drawLoop(ctx, body, paint, { canvas, view, toDevice, offRef });
        else drawOutline(ctx, body, paint, view);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
    };

    /* geometry changes: a drag, a layout, an add/remove, a reparent — and
       `mapgraphgeometry`, which the one geometry reset emits after it has settled
       the stacking passes this layer reads its colours and its z-order from */
    cy.on('position', 'node', markDirty);
    cy.on('add remove move', markDirty);
    cy.on('mapgraphgeometry', markDirty);
    cy.on('render', draw);

    const ro = new ResizeObserver(draw);
    ro.observe(wrapper);
    draw();

    return () => {
      ro.disconnect();
      wrapper.removeEventListener('pointermove', onPointerMove, true);
      wrapper.removeEventListener('pointerdown', onPointerDown, true);
      cy.off('position', 'node', markDirty);
      cy.off('add remove move', markDirty);
      cy.off('mapgraphgeometry', markDirty);
      cy.off('render', draw);
    };
  }, [handle]);

  return <canvas ref={canvasRef} className="group-shape-layer" aria-hidden="true" />;
}

/* --------------------------------------------------------------- painting */

interface Paint {
  fill: string;
  border: string;
  fillOpacity: number;
  borderOpacity: number;
  borderWidth: number;
  /** The route dim, applied to the whole body at once. */
  alpha: number;
}

/**
 * The colours a Cytoscape rectangle would have had, read off the very same node
 * data — `groupFillOpacity` / `groupBorderOpacity` are the layering pass's
 * translucency ramp, and the interaction states are the classes the highlight
 * pass puts on. Kept in step with the `node.group` rules in `style.ts` by hand,
 * because a canvas cannot ask a stylesheet what it would have drawn.
 */
function paintOf(body: GroupBody): Paint {
  const n = body.node;
  const skel = !!n.data('skel');
  const highlighted = n.hasClass('hl-primary');

  let fillOpacity = (n.data('groupFillOpacity') as number) || 0.2;
  if (skel) fillOpacity = Math.min(0.55, fillOpacity * 1.6);
  if (highlighted) fillOpacity = Math.max(fillOpacity, 0.3);

  return {
    fill: (n.data('fill') as string) || PALETTE.groupFill,
    border: highlighted ? PALETTE.highlight : (n.data('border') as string) || PALETTE.groupBorder,
    fillOpacity,
    borderOpacity: highlighted ? 1 : (n.data('groupBorderOpacity') as number) || 0.75,
    borderWidth: highlighted ? 5 : skel ? 3 : 2,
    alpha: n.hasClass('route-dim') ? 0.5 : 1
  };
}

const traceRings = (ctx: CanvasRenderingContext2D, rings: Pt[][]) => {
  ctx.beginPath();
  for (const ring of rings) {
    if (ring.length < 3) continue;
    ctx.moveTo(ring[0].x, ring[0].y);
    for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i].x, ring[i].y);
    ctx.closePath();
  }
};

const tracePath = (ctx: CanvasRenderingContext2D, pts: Pt[]) => {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
};

/** A rectangle grouping, painted here now instead of by Cytoscape's compound
 *  node — the rounded corner is the one curve in the whole subsystem, kept
 *  because a hard-cornered box would read as a regression from the original. */
function drawRect(
  ctx: CanvasRenderingContext2D,
  body: GroupBody,
  paint: Paint,
  view: (c: CanvasRenderingContext2D) => void
) {
  const b = body.bounds;
  ctx.save();
  view(ctx);
  const r = Math.min(10, (b.x2 - b.x1) / 4, (b.y2 - b.y1) / 4);
  ctx.beginPath();
  ctx.roundRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1, Math.max(0, r));
  ctx.globalAlpha = paint.alpha * paint.fillOpacity;
  ctx.fillStyle = paint.fill;
  ctx.fill();
  ctx.globalAlpha = paint.alpha * paint.borderOpacity;
  ctx.strokeStyle = paint.border;
  ctx.lineWidth = paint.borderWidth;
  ctx.stroke();
  ctx.restore();
}

/**
 * The union's rings never overlap one another, so fill and stroke can go straight
 * onto the canvas — exactly as Cytoscape paints a rectangle, border alpha
 * straddling fill alpha and all. `evenodd` is what makes a grouping laid out in a
 * ring show the hole in its middle.
 */
function drawOutline(
  ctx: CanvasRenderingContext2D,
  body: GroupBody,
  paint: Paint,
  view: (c: CanvasRenderingContext2D) => void
) {
  if (!body.rings.length) return;
  ctx.save();
  view(ctx);
  ctx.lineJoin = 'miter';
  ctx.miterLimit = 4;

  traceRings(ctx, body.rings);
  ctx.globalAlpha = paint.alpha * paint.fillOpacity;
  ctx.fillStyle = paint.fill;
  ctx.fill('evenodd');

  ctx.globalAlpha = paint.alpha * paint.borderOpacity;
  ctx.strokeStyle = paint.border;
  ctx.lineWidth = paint.borderWidth;
  ctx.stroke();
  ctx.restore();
}

interface LoopContext {
  canvas: HTMLCanvasElement;
  view: (c: CanvasRenderingContext2D) => void;
  toDevice: (x: number, y: number) => Pt;
  offRef: { current: HTMLCanvasElement | null };
}

/**
 * The band is *one* stroke, so its border and its fill cannot simply be two
 * translucent strokes on top of each other — the fill would be painted over the
 * border it sits inside, and the band would read as border-plus-fill rather than
 * fill. Each is composited opaque on an offscreen buffer and blitted once at its
 * own alpha: the border as a ring (stroke the outer width, erase the inner), the
 * fill as the plain band. Only the band's own screen-space box is ever touched.
 */
function drawLoop(main: CanvasRenderingContext2D, body: GroupBody, paint: Paint, ctxs: LoopContext) {
  const loop = body.loop!;
  const bounds = bodyBounds(body);

  const off = (ctxs.offRef.current ??= document.createElement('canvas'));
  if (off.width !== ctxs.canvas.width || off.height !== ctxs.canvas.height) {
    off.width = ctxs.canvas.width;
    off.height = ctxs.canvas.height;
  }
  const octx = off.getContext('2d');
  if (!octx) return;

  const slack = paint.borderWidth + 2;
  const a = ctxs.toDevice(bounds.x1, bounds.y1);
  const b = ctxs.toDevice(bounds.x2, bounds.y2);
  const x = Math.max(0, Math.floor(a.x - slack));
  const y = Math.max(0, Math.floor(a.y - slack));
  const w = Math.min(ctxs.canvas.width, Math.ceil(b.x + slack)) - x;
  const h = Math.min(ctxs.canvas.height, Math.ceil(b.y + slack)) - y;
  if (w <= 0 || h <= 0) return; // entirely off screen

  const band = (ctx: CanvasRenderingContext2D) => {
    ctx.lineJoin = 'miter';
    ctx.miterLimit = 4;
    ctx.lineCap = 'butt';
    tracePath(ctx, loop.centreline);
  };
  const blit = (alpha: number) => {
    main.save();
    main.setTransform(1, 0, 0, 1, 0, 0);
    main.globalAlpha = paint.alpha * alpha;
    main.drawImage(off, x, y, w, h, x, y, w, h);
    main.restore();
  };

  /* 1 ── the border: the outer band, with the inner band punched out of it */
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(x, y, w, h);
  ctxs.view(octx);
  band(octx);
  octx.globalCompositeOperation = 'source-over';
  octx.strokeStyle = paint.border;
  octx.lineWidth = loop.band + paint.borderWidth * 2;
  octx.stroke();
  octx.globalCompositeOperation = 'destination-out';
  octx.lineWidth = loop.band;
  octx.stroke();
  octx.globalCompositeOperation = 'source-over';
  blit(paint.borderOpacity);

  /* 2 ── the body: the band itself */
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(x, y, w, h);
  ctxs.view(octx);
  band(octx);
  octx.strokeStyle = paint.fill;
  octx.lineWidth = loop.band;
  octx.stroke();
  blit(paint.fillOpacity);
}
