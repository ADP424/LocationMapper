import { useEffect } from 'react';
import { applyDragModes } from '../../graph/dragModes';
import type { DragMode } from '../../state/settings';
import type { CanvasHandle } from './handle';

export function useDragModes(
  handle: CanvasHandle | null,
  groupDrag: DragMode,
  locationDrag: DragMode,
  picked: ReadonlySet<string>,
  elements: unknown
) {
  useEffect(() => {
    if (!handle) return;
    applyDragModes(handle.cy, { groups: groupDrag, locations: locationDrag, picked });
    /* `elements` so freshly added rooms and groupings are configured too */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, groupDrag, locationDrag, picked, elements]);
}
