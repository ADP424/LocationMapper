import type { ElementDefinition } from 'cytoscape';
import { useEffect, useRef } from 'react';
import { buildConnectionIndex } from '../../graph/highlight';
import { reconcile } from '../../graph/reconcile';
import { refreshMinZoom } from '../../graph/zoomBounds';
import type { CanvasHandle } from './handle';

/**
 * Reconciles the desired element set into Cytoscape, then re-derives
 * everything that depends purely on *geometry* (the grouping stack, the
 * ViewScaler's buckets, the zoom floor). Highlighting is handled by a
 * separate hook (`useHighlight`) so a selection change never pays for any of
 * this — it only ever needs to re-run classes.
 */
export function useElementSync(handle: CanvasHandle | null, elements: ElementDefinition[], mapId: string | null) {
  const lastMapRef = useRef<string | null>(null);

  useEffect(() => {
    if (!handle) return;
    const { cy, scaler } = handle;
    const fullReset = lastMapRef.current !== mapId;
    lastMapRef.current = mapId;

    const extent = cy.extent();
    const centre = {
      x: Number.isFinite(extent.x1) ? (extent.x1 + extent.x2) / 2 : 0,
      y: Number.isFinite(extent.y1) ? (extent.y1 + extent.y2) / 2 : 0
    };

    const result = reconcile(cy, elements, fullReset, centre);
    if (fullReset || result.structural) {
      scaler.build();
    } else {
      if (result.dirty.length) scaler.markDirty(result.dirty);
      scaler.reposition();
    }
    /* groupings are drawn bottom-most; their order follows the rooms */
    handle.restack();
    /* …and a bigger (or smaller) map can be pulled back further (or less) */
    refreshMinZoom(cy, handle.settingsRef.current);
    /* a precise, once-per-reconcile signal — unlike `style`, which fires per element */
    cy.emit('mapgraphgeometry');
    handle.connIndexRef.current = buildConnectionIndex(cy);
    if (result.structural) cy.forceRender();

    if (fullReset) {
      requestAnimationFrame(() => {
        if (handle.cy !== cy) return;
        cy.resize();
        if (cy.nodes().length) handle.fitAndRescale(60);
        cy.forceRender();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, elements, mapId]);
}
