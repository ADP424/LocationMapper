import type { Core } from 'cytoscape';
import { groupNodeId } from './elements';

/** `fit` is registered by GraphCanvas, which owns the view-scale bookkeeping. */
export const cyHolder: { cy: Core | null; fit: ((padding?: number) => void) | null } = {
  cy: null,
  fit: null
};

export function fitGraph(padding?: number) {
  cyHolder.fit?.(padding);
}

export function focusLocation(id: string, select: (id: string) => void) {
  const cy = cyHolder.cy;
  select(id);
  if (!cy) return;
  const node = cy.getElementById(id);
  if (node.empty()) return;
  cy.stop();
  cy.animate(
    { center: { eles: node }, zoom: Math.max(cy.zoom(), 0.9) },
    { duration: 350, easing: 'ease-in-out-cubic' }
  );
}

export function focusConnection(id: string, select: (id: string) => void) {
  const cy = cyHolder.cy;
  select(id);
  if (!cy) return;
  const eles = cy.elements(`[connectionId = "${id}"]`);
  const all = eles.union(eles.connectedNodes()).union(eles.neighborhood());
  if (all.empty()) return;
  cy.stop();
  cy.animate({ fit: { eles: all, padding: 120 } }, { duration: 350 });
}

export function focusGroup(id: string, select: (id: string) => void) {
  const cy = cyHolder.cy;
  select(id);
  if (!cy) return;
  const node = cy.getElementById(groupNodeId(id));
  if (node.empty()) return;
  cy.stop();
  cy.animate({ fit: { eles: node.union(node.descendants()), padding: 90 } }, { duration: 350 });
}
