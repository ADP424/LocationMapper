import { useEffect } from 'react';
import type { Selection } from '../../types';
import type { CanvasHandle } from './handle';

/** Keep Cytoscape's native selection in step with the store. */
export function useSelectionSync(handle: CanvasHandle | null, selection: Selection | null, multiSelect: string[]) {
  useEffect(() => {
    if (!handle) return;
    const { cy } = handle;
    if (multiSelect.length > 1) return;
    cy.batch(() => {
      cy.elements().unselect();
      if (selection?.type === 'location') cy.getElementById(selection.id).select();
    });
  }, [handle, selection, multiSelect]);
}
