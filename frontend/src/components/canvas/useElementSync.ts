import type { ElementDefinition } from 'cytoscape';
import { useEffect, useRef } from 'react';
import { buildConnectionIndex } from '../../graph/highlight';
import { reconcile } from '../../graph/reconcile';
import { FIT_PADDING } from '../../graph/zoomBounds';
import type { CanvasHandle } from './handle';

/**
 * Reconciles the desired element set into Cytoscape, and — only when the
 * reconcile actually moved, added, removed or resized something — hands the
 * canvas to `sync()`, which owns every geometry-derived bound.
 *
 * `buildElements` rebuilds its array on every store change, so this effect runs
 * on every click. It used to re-index the whole graph, rebuild both spatial
 * grids and re-solve the zoom floor each time — which is why a stale zoom floor
 * silently repaired itself the moment you selected something.
 */
export function useElementSync(
  handle: CanvasHandle | null,
  elements: ElementDefinition[],
  mapId: string | null
) {
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

    /* the index maps connectionId -> elements: only a structural change moves it */
    if (fullReset || result.structural) handle.connIndexRef.current = buildConnectionIndex(cy);
    if (result.dirty.length) scaler.markDirty(result.dirty);

    /* a selection, a highlight or a notes edit changes no geometry at all */
    if (!fullReset && !result.structural && !result.moved && !result.dirty.length) return;

    handle.sync({
      rebuild: fullReset || result.structural,
      fit: fullReset ? FIT_PADDING : undefined
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, elements, mapId]);
}
