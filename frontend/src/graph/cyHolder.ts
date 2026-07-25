import type { Core } from 'cytoscape';

export const cyHolder: { cy: Core | null } = { cy: null };

/** Pan/zoom to a location and select it. */
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

/** Frame a connection: fit both endpoints (or its stubs) on screen. */
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
