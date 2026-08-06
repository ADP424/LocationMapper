import { useEffect, useRef, useState } from 'react';
import { useGraphStore } from '../../state/store';
import { boxOf, renderedToModel } from './hitTest';
import type { CanvasHandle } from './handle';

export interface MarqueeBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Right-drag over empty space *or a grouping box* to select many rooms. */
export function useMarquee(handle: CanvasHandle | null): MarqueeBox | null {
  const [marquee, setMarquee] = useState<MarqueeBox | null>(null);
  const boxRef = useRef<MarqueeBox | null>(null);

  useEffect(() => {
    if (!handle) return;
    const { cy, cxtStartRef, suppressMenuRef } = handle;

    const onStart = (ev: any) => {
      suppressMenuRef.current = false;
      /* a grouping box must not block a marquee — one never catches groupings */
      if (ev.target !== cy && !ev.target.hasClass('group')) {
        cxtStartRef.current = null;
        return;
      }
      const rp = ev.renderedPosition ?? { x: 0, y: 0 };
      cxtStartRef.current = { x: rp.x, y: rp.y, moved: false };
    };

    const onDrag = (ev: any) => {
      const start = cxtStartRef.current;
      if (!start) return;
      const rp = ev.renderedPosition ?? { x: 0, y: 0 };
      if (!start.moved && Math.hypot(rp.x - start.x, rp.y - start.y) < 5) return;
      start.moved = true;
      suppressMenuRef.current = true;
      const box = {
        x1: Math.min(start.x, rp.x),
        y1: Math.min(start.y, rp.y),
        x2: Math.max(start.x, rp.x),
        y2: Math.max(start.y, rp.y)
      };
      boxRef.current = box;
      setMarquee(box);
    };

    const onEnd = () => {
      const start = cxtStartRef.current;
      const box = boxRef.current;
      cxtStartRef.current = null;
      boxRef.current = null;
      setMarquee(null);
      if (!start?.moved || !box) return;

      const p1 = renderedToModel(cy, box.x1, box.y1);
      const p2 = renderedToModel(cy, box.x2, box.y2);
      const ids: string[] = [];
      cy.nodes('.location').forEach((n) => {
        const bb = boxOf(n);
        if (bb.x1 < p2.x && bb.x2 > p1.x && bb.y1 < p2.y && bb.y2 > p1.y) ids.push(n.id());
      });

      cy.batch(() => {
        cy.elements().unselect();
        ids.forEach((id) => cy.getElementById(id).select());
      });
      useGraphStore.getState().setMultiSelect(ids);
    };

    cy.on('cxttapstart', onStart);
    cy.on('cxtdrag', onDrag);
    cy.on('cxttapend', onEnd);
    return () => {
      cy.off('cxttapstart', onStart);
      cy.off('cxtdrag', onDrag);
      cy.off('cxttapend', onEnd);
    };
  }, [handle]);

  return marquee;
}
