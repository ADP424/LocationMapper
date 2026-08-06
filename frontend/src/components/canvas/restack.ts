import type { Core } from 'cytoscape';
import { applyGroupLayers, applyRoomLayers, computeGroupLayers } from '../../graph/layering';
import { COORDINATE_LAYOUTS, isCoordinateLayout, type LayoutName } from '../../graph/layouts';
import { useGraphStore } from '../../state/store';

/**
 * Recompute the grouping stack and push it onto the graph, synchronously —
 * called right after positions are written so there is no round-trip through
 * the server before the stack (and the sidebar's "Layer N/M" readout) catch up.
 *
 * `rooms: false` (used after a plain drag) skips re-sorting the rooms: their
 * order depends only on area / off-plane coordinate, neither of which a drag
 * changes — only the grouping footprints need refreshing.
 */
export function restack(cy: Core, layeringSource: LayoutName, opts: { rooms?: boolean } = {}) {
  const { groups, locations } = useGraphStore.getState();
  const plane = isCoordinateLayout(layeringSource) ? COORDINATE_LAYOUTS[layeringSource] : null;
  const layers = computeGroupLayers(cy, Object.values(groups), Object.values(locations), plane);
  applyGroupLayers(cy, layers);
  if (opts.rooms !== false) applyRoomLayers(cy, locations, plane);
  useGraphStore.getState().setGroupLayers(layers);
}
