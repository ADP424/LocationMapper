import type { Core } from 'cytoscape';
import { worldHolder } from '../world/scene/viewHolder';
import { groupNodeId } from './elements';

export const cyHolder: { cy: Core | null } = { cy: null };

/**
 * "Show me this" means whichever canvas is mounted.
 *
 * Every panel in the sidebar routes through these helpers, so putting the
 * branch here is what makes search, the inspector's endpoint links and the trip
 * planner all work in 3D without touching any of them.
 */
export function focusLocation(id: string, select: (id: string) => void) {
  const cy = cyHolder.cy;
  select(id);
  if (worldHolder.view) {
    worldHolder.view.focusLocation(id);
    return;
  }
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
  /* Selecting is the whole gesture in 3D: a connection has no position of its
     own, and this helper is only given an id, so there is nothing here to aim
     the camera at. The line highlights where it already is. */
  if (worldHolder.view) return;
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
  /* Groupings are a 2D layout device — they have no box in the world. */
  if (worldHolder.view) return;
  if (!cy) return;
  const node = cy.getElementById(groupNodeId(id));
  if (node.empty()) return;
  cy.stop();
  cy.animate({ fit: { eles: node.union(node.descendants()), padding: 90 } }, { duration: 350 });
}
