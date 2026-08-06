import { useEffect } from 'react';
import type { CanvasHandle } from './handle';

const GHOST_NODE = '__ghost__';
const GHOST_EDGE = '__ghost-edge__';

/** The rubber band while creating a connection. */
export function useConnectGhost(handle: CanvasHandle | null, mode: string, pendingSource: string | null) {
  useEffect(() => {
    if (!handle) return;
    const { cy, scaler } = handle;

    const removeGhost = () => {
      cy.getElementById(GHOST_EDGE).remove();
      cy.getElementById(GHOST_NODE).remove();
    };

    cy.nodes('.connect-source').removeClass('connect-source');
    removeGhost();

    if (mode !== 'connect' || !pendingSource) return;
    const source = cy.getElementById(pendingSource);
    if (source.empty()) return;

    source.addClass('connect-source');
    const p = source.position();
    const ghost = cy.add([
      {
        group: 'nodes',
        data: { id: GHOST_NODE, w: 6, h: 6 },
        position: { x: p.x + 60, y: p.y + 60 },
        selectable: false,
        grabbable: false,
        classes: 'ghost'
      },
      {
        group: 'edges',
        data: { id: GHOST_EDGE, source: pendingSource, target: GHOST_NODE, lineWidth: 3 },
        selectable: false,
        classes: 'ghost-edge'
      }
    ]);
    scaler.applyTo(ghost);

    const onMove = (ev: any) => {
      const ghostNode = cy.getElementById(GHOST_NODE);
      if (ghostNode.nonempty()) ghostNode.position(ev.position);
    };
    cy.on('mousemove', onMove);

    return () => {
      cy.off('mousemove', onMove);
      cy.nodes('.connect-source').removeClass('connect-source');
      removeGhost();
    };
  }, [handle, mode, pendingSource]);
}
