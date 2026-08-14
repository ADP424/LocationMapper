import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { CoordinateFrame } from '../../graph/coordinateLayout';
import { solveGrid, type GridLine } from '../../graph/coordinateGrid';
import { skeletonAt } from '../../graph/viewScale';
import type { Settings } from '../../state/settings';
import { cssColor } from '../../utils/colors';
import { applyCssTransform, createOverlaySurface, type OverlayView } from './overlayCanvas';
import type { CanvasHandle } from './handle';

/**
 * The coordinate lattice, in two halves that deliberately sit on opposite sides
 * of Cytoscape's own canvases:
 *
 *   `CoordinateGridLayer` — the lines. Paper, so it goes *under* everything,
 *     by DOM order, exactly as `GroupShapeLayer` does.
 *   `CoordinateGridRuler` — the numbers. A ruler is useless if a room can sit
 *     on top of it, so this one goes *over* the graph, pinned to the viewport
 *     edges rather than to the map, and carries a plate for legibility.
 *
 * Both share one solver and one paint loop, and both draw in CSS pixels: the
 * lines stay exactly one pixel at every zoom and device ratio, and the numbers
 * stay the same size on screen whatever `baseScale` or the compensation is
 * doing to the map's own names.
 */

type GridPaint = (ctx: CanvasRenderingContext2D, view: OverlayView) => void;

export interface GridLayerProps {
  handle: CanvasHandle | null;
  /** null when the grid is off, or when nothing has been laid out on a lattice. */
  frame: CoordinateFrame | null;
  settings: Settings;
}

/* A line's weight is its meaning: coordinate zero anchors you, the majors give
   a coarse grid a countable rhythm, the minors are the lattice itself. */
const ALPHA = {
  minor: 0.085,
  major: 0.18,
  axis: 0.34,
  skelMajor: 0.14,
  skelAxis: 0.26
};

const FONT_PX = 10;
const TOP_Y = 11;
const LEFT_X = 6;
const CHIP_PAD_X = 3;
const CHIP_PAD_Y = 2;

/** Shared canvas plumbing: the backing store is measured, never assumed (see
 *  `overlayCanvas.ts`), and the paint runs on Cytoscape's own render cadence so
 *  the two can never disagree about pan, zoom — or about where a pixel is. */
function useGridCanvas(handle: CanvasHandle | null, paint: GridPaint | null) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!handle || !canvas) return;
    const { cy } = handle;

    function draw() {
      if (cy.destroyed()) return;
      const view = surface.view();
      const ctx = canvas!.getContext('2d');
      if (!view || !ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas!.width, canvas!.height);
      if (!paint) return;
      /* CSS pixels from here on, so a "1px" line really is one CSS pixel and a
         10px number really is ten — whatever the display is doing */
      applyCssTransform(ctx, view);
      paint(ctx, view);
    }

    const surface = createOverlaySurface(canvas, draw);
    draw();
    /* grid off: the canvas stays sized and clear, and we stay out of the loop */
    if (!paint) return () => surface.destroy();

    cy.on('render', draw);
    return () => {
      cy.off('render', draw);
      surface.destroy();
    };
  }, [handle, paint]);

  return canvasRef;
}

/* ------------------------------------------------------------------ lines */

export default function CoordinateGridLayer({ handle, frame, settings }: GridLayerProps) {
  const paint = useMemo<GridPaint | null>(() => {
    if (!handle || !frame) return null;
    const { cy } = handle;

    return (ctx, { cssW, cssH }) => {
      const g = solveGrid(cy, frame, settings);
      if (!g) return;
      ctx.strokeStyle = cssColor('--grid-line', '#243244');

      const stroke = (
        lines: GridLine[],
        vertical: boolean,
        alpha: number,
        width: number,
        want: (l: GridLine) => boolean
      ) => {
        ctx.globalAlpha = alpha;
        ctx.lineWidth = width;
        ctx.beginPath();
        let any = false;
        for (const l of lines) {
          if (!want(l)) continue;
          /* half-pixel snap: an unsnapped 1px line is drawn as two grey ones */
          const p = Math.round(l.px) + 0.5;
          if (vertical) {
            ctx.moveTo(p, 0);
            ctx.lineTo(p, cssH);
          } else {
            ctx.moveTo(0, p);
            ctx.lineTo(cssW, p);
          }
          any = true;
        }
        if (any) ctx.stroke();
      };

      /* the skeleton is already a sea of grouping boxes; a fine lattice would
         compete with it, so only the rhythm and the axes survive out there */
      if (!g.skeleton) {
        const plain = (l: GridLine) => !l.major && !l.axis;
        stroke(g.cols, true, ALPHA.minor, 1, plain);
        stroke(g.rows, false, ALPHA.minor, 1, plain);
      }
      const majorAlpha = g.skeleton ? ALPHA.skelMajor : ALPHA.major;
      const majorOnly = (l: GridLine) => l.major && !l.axis;
      stroke(g.cols, true, majorAlpha, 1, majorOnly);
      stroke(g.rows, false, majorAlpha, 1, majorOnly);

      const axisAlpha = g.skeleton ? ALPHA.skelAxis : ALPHA.axis;
      const axisOnly = (l: GridLine) => l.axis;
      stroke(g.cols, true, axisAlpha, 1.5, axisOnly);
      stroke(g.rows, false, axisAlpha, 1.5, axisOnly);

      ctx.globalAlpha = 1;
    };
  }, [handle, frame, settings]);

  const ref = useGridCanvas(handle, paint);
  return <canvas ref={ref} className="coord-grid-layer" aria-hidden="true" />;
}

/* ----------------------------------------------------------------- numbers */

export function CoordinateGridRuler({ handle, frame, settings }: GridLayerProps) {
  const chip = useCallback(
    (
      ctx: CanvasRenderingContext2D,
      text: string,
      x: number,
      y: number,
      centred: boolean,
      ink: string,
      plate: string,
      emphasis: boolean
    ) => {
      const w = ctx.measureText(text).width;
      const x0 = centred ? Math.round(x - w / 2) : x;
      ctx.globalAlpha = 0.82;
      ctx.fillStyle = plate;
      ctx.beginPath();
      ctx.roundRect(
        x0 - CHIP_PAD_X,
        y - FONT_PX / 2 - CHIP_PAD_Y,
        w + CHIP_PAD_X * 2,
        FONT_PX + CHIP_PAD_Y * 2,
        3
      );
      ctx.fill();
      ctx.globalAlpha = emphasis ? 0.95 : 0.68;
      ctx.fillStyle = ink;
      ctx.fillText(text, x0, y);
    },
    []
  );

  const paint = useMemo<GridPaint | null>(() => {
    if (!handle || !frame) return null;
    const { cy } = handle;

    return (ctx, { cssW, cssH }) => {
      /* cheap out before the solve: the skeleton never carries numbers */
      if (skeletonAt(cy.zoom(), settings)) return;
      const g = solveGrid(cy, frame, settings);
      if (!g || !g.labels) return;

      const ink = cssColor('--grid-text', '#33415c');
      const plate = cssColor('--canvas-1', '#f3f6fb');
      ctx.font = `${FONT_PX}px Inter, system-ui, -apple-system, sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';

      /* vertical lines read along the top edge … */
      for (const l of g.cols) {
        if (!l.label) continue;
        const x = l.px;
        if (x < 2 || x > cssW - 2) continue;
        chip(ctx, String(l.coord), x, TOP_Y, true, ink, plate, l.axis);
      }
      /* … horizontal lines down the left, skipping the corner the row above
         already occupies */
      const corner = TOP_Y + FONT_PX;
      for (const l of g.rows) {
        if (!l.label) continue;
        const y = Math.round(l.px);
        if (y < corner || y > cssH - 4) continue;
        chip(ctx, String(l.coord), LEFT_X, y, false, ink, plate, l.axis);
      }

      ctx.globalAlpha = 1;
    };
  }, [handle, frame, settings, chip]);

  const ref = useGridCanvas(handle, paint);
  return <canvas ref={ref} className="coord-grid-ruler" aria-hidden="true" />;
}
