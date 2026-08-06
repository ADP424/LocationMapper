import { useEffect } from 'react';
import { applyHighlight } from '../../graph/highlight';
import type { RoutePlan } from '../../graph/pathfinding';
import type { Selection } from '../../types';
import type { CanvasHandle } from './handle';

/**
 * Highlighting is orthogonal to geometry: it must never pay for the
 * reconcile, the stacking pass, or the view-scale pass. It re-runs on element
 * changes too, so fresh elements pick up route/selection classes — class
 * writes that change nothing are free in Cytoscape.
 */
export function useHighlight(
  handle: CanvasHandle | null,
  elements: unknown,
  selection: Selection | null,
  multiSelect: string[],
  labelMembers: string[],
  routePlan: RoutePlan | null,
  waypoints: string[]
) {
  useEffect(() => {
    if (!handle) return;
    applyHighlight(handle.cy, handle.connIndexRef.current, selection, multiSelect, labelMembers, routePlan, waypoints);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, selection, multiSelect, labelMembers, routePlan, waypoints, elements]);
}
