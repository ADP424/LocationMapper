import type { Core, NodeSingular } from 'cytoscape';
import type { DragMode } from '../state/settings';

/**
 * `panify`/`unpanify` are runtime APIs that some `@types/cytoscape` versions do
 * not declare. A node that is neither grabbable nor pannable swallows the drag
 * entirely, so the two flags always move together.
 */
interface PanFlags {
  panify(): void;
  unpanify(): void;
}

/**
 * Marks an element the user pans *through*. Cytoscape's default stylesheet gives
 * `:active` elements a dark halo and a natively selected node an overlay tint;
 * both of those read as a flicker when the gesture was only a pan, so the style
 * for this class zeroes the overlay (see graph/style).
 */
export const PAN_THROUGH = 'pan-through';

function setDraggable(node: NodeSingular, draggable: boolean) {
  /* the class is wiped by every element reconcile, so check it as well as the
     flag — otherwise the common case would silently stop repairing itself */
  if (node.grabbable() === draggable && node.hasClass(PAN_THROUGH) === !draggable) return;

  const pan = node as unknown as PanFlags;
  if (draggable) {
    node.grabify();
    pan.unpanify();
    node.removeClass(PAN_THROUGH);
  } else {
    node.ungrabify();
    pan.panify();
    node.addClass(PAN_THROUGH);
  }
}

export interface DragModes {
  groups: DragMode;
  locations: DragMode;
  /** Room ids and grouping *node* ids that count as selected right now. */
  picked: ReadonlySet<string>;
}

/** Reconcile every room and grouping with the current drag/pan settings. */
export function applyDragModes(cy: Core, modes: DragModes) {
  const draggable = (mode: DragMode, id: string) =>
    mode === 'always' || (mode === 'selected' && modes.picked.has(id));

  cy.batch(() => {
    cy.nodes('.group').forEach((g) => setDraggable(g, draggable(modes.groups, g.id())));
    cy.nodes('.location').forEach((n) => setDraggable(n, draggable(modes.locations, n.id())));
  });
}
