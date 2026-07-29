import { useEffect, useRef, useState } from 'react';
import { cyHolder } from '../graph/cyHolder';

interface Bar {
  /** thumb length as a fraction of the track */
  size: number;
  /** thumb start as a fraction of the track */
  offset: number;
  visible: boolean;
}

const EMPTY: Bar = { size: 1, offset: 0, visible: false };

/** Breathing room past the content on each side, as a fraction of the viewport. */
const EDGE_PAD = 1 / 16;

export default function GraphScrollbars() {
  const [hBar, setHBar] = useState<Bar>(EMPTY);
  const [vBar, setVBar] = useState<Bar>(EMPTY);
  /** union of content + viewport — used only to map pixels ↔ model for display */
  const rangeRef = useRef({ x1: 0, x2: 1, y1: 0, y2: 1 });

  useEffect(() => {
    const cy = cyHolder.cy;
    if (!cy) return;
    let frame = 0;

    const update = () => {
      frame = 0;
      const ext = cy.extent();
      const bb = cy.elements().nonempty() ? cy.elements().boundingBox() : ext;

      /* track = content plus a margin, stretched only as far as the viewport
         has wandered beyond it */
      const padX = ext.w * EDGE_PAD;
      const padY = ext.h * EDGE_PAD;
      const x1 = Math.min(bb.x1 - padX, ext.x1);
      const x2 = Math.max(bb.x2 + padX, ext.x2);
      const y1 = Math.min(bb.y1 - padY, ext.y1);
      const y2 = Math.max(bb.y2 + padY, ext.y2);
      rangeRef.current = { x1, x2, y1, y2 };

      const totalW = Math.max(1, x2 - x1);
      const totalH = Math.max(1, y2 - y1);

      setHBar({
        size: Math.min(1, ext.w / totalW),
        offset: (ext.x1 - x1) / totalW,
        visible: ext.w < totalW - 1
      });
      setVBar({
        size: Math.min(1, ext.h / totalH),
        offset: (ext.y1 - y1) / totalH,
        visible: ext.h < totalH - 1
      });
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };

    cy.on('viewport', schedule);
    cy.on('add remove position style', schedule);
    schedule();

    return () => {
      cy.off('viewport', schedule);
      cy.off('add remove position style', schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  /** Put the given model coordinate at the viewport's leading edge. */
  const panTo = (axis: 'x' | 'y', edge: number) => {
    const cy = cyHolder.cy;
    if (!cy) return;
    const zoom = cy.zoom();
    const pan = cy.pan();
    if (axis === 'x') cy.pan({ x: -edge * zoom, y: pan.y });
    else cy.pan({ x: pan.x, y: -edge * zoom });
  };

  /** Content bounds + viewport span on one axis, captured at interaction time. */
  const axisInfo = (axis: 'x' | 'y') => {
    const cy = cyHolder.cy!;
    const bb = cy.elements().nonempty() ? cy.elements().boundingBox() : cy.extent();
    const ext = cy.extent();
    const span = axis === 'x' ? ext.w : ext.h;
    /* the same margin the track shows is also genuinely scrollable */
    const pad = span * EDGE_PAD;
    const cMin = (axis === 'x' ? bb.x1 : bb.y1) - pad;
    const cMax = (axis === 'x' ? bb.x2 : bb.y2) + pad;
    const startEdge = axis === 'x' ? ext.x1 : ext.y1;
    /* you can never scroll a viewport edge past the padded content edge */
    const clamp = (edge: number) =>
      Math.max(cMin, Math.min(cMax - span, edge));
    return { cMin, cMax, span, startEdge, scrollable: cMax - cMin > span + 0.5, clamp };
  };

  const startDrag = (axis: 'x' | 'y', e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const cy = cyHolder.cy;
    if (!cy) return;

    const info = axisInfo(axis);
    if (!info.scrollable) return;

    const track = (e.currentTarget as HTMLElement).parentElement!;
    const trackSize = axis === 'x' ? track.clientWidth : track.clientHeight;
    const start = axis === 'x' ? e.clientX : e.clientY;
    const range = rangeRef.current;
    const unionTotal = axis === 'x' ? range.x2 - range.x1 : range.y2 - range.y1;

    const move = (ev: PointerEvent) => {
      const delta = (axis === 'x' ? ev.clientX : ev.clientY) - start;
      const target = info.startEdge + (delta / Math.max(1, trackSize)) * unionTotal;
      panTo(axis, info.clamp(target));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /** Clicking the track centres the viewport on that spot (clamped to content). */
  const jump = (axis: 'x' | 'y', e: React.PointerEvent) => {
    const cy = cyHolder.cy;
    if (!cy) return;
    const info = axisInfo(axis);
    if (!info.scrollable) return;

    const track = e.currentTarget as HTMLElement;
    const rect = track.getBoundingClientRect();
    const fraction =
      axis === 'x'
        ? (e.clientX - rect.left) / Math.max(1, rect.width)
        : (e.clientY - rect.top) / Math.max(1, rect.height);

    const range = rangeRef.current;
    const total = axis === 'x' ? range.x2 - range.x1 : range.y2 - range.y1;
    const origin = axis === 'x' ? range.x1 : range.y1;
    panTo(axis, info.clamp(origin + fraction * total - info.span / 2));
  };

  return (
    <>
      {hBar.visible && (
        <div className="gscroll gscroll-h" onPointerDown={(e) => jump('x', e)}>
          <div
            className="gscroll-thumb"
            style={{ left: `${hBar.offset * 100}%`, width: `${Math.max(hBar.size * 100, 4)}%` }}
            onPointerDown={(e) => startDrag('x', e)}
          />
        </div>
      )}
      {vBar.visible && (
        <div className="gscroll gscroll-v" onPointerDown={(e) => jump('y', e)}>
          <div
            className="gscroll-thumb"
            style={{ top: `${vBar.offset * 100}%`, height: `${Math.max(vBar.size * 100, 4)}%` }}
            onPointerDown={(e) => startDrag('y', e)}
          />
        </div>
      )}
    </>
  );
}
