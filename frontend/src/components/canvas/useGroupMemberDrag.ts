import type { NodeSingular } from 'cytoscape';
import { useEffect } from 'react';
import { descendantGroupIds } from '../../graph/groups';
import { useGraphStore } from '../../state/store';
import type { CanvasHandle } from './handle';

/**
 * Dragging a grouping moves *every* member, not just the rooms it anchors.
 * Cytoscape's compound drag already carries the anchored subtree (and any
 * nested groupings' anchored subtrees); this carries the rest — members whose
 * anchor is a different grouping — accepting that doing so tears the
 * groupings they are anchored in, whose bodies simply reflow around the gap.
 */
export function useGroupMemberDrag(handle: CanvasHandle | null) {
  useEffect(() => {
    if (!handle) return;
    const { cy } = handle;

    let grabbed: NodeSingular | null = null;
    let origin: { x: number; y: number } | null = null;
    let extras: Array<{ n: NodeSingular; x: number; y: number }> = [];

    const onGrab = (e: any) => {
      const g = e.target as NodeSingular;
      grabbed = g;
      origin = { ...g.position() };
      const { locations, groups } = useGraphStore.getState();
      /* the grouping and everything nested under it — implied membership */
      const ids = descendantGroupIds(Object.values(groups), g.data('groupId') as string);
      extras = [];
      for (const l of Object.values(locations)) {
        if (!l.groupIds.some((gid) => ids.has(gid))) continue;
        const n = cy.getElementById(l.id);
        if (n.empty() || n.grabbed()) continue;
        if (n.ancestors().anySame(g)) continue; // the compound drag already has it
        extras.push({ n, x: n.position('x'), y: n.position('y') });
      }
    };
    const onDrag = (e: any) => {
      if (e.target !== grabbed || !grabbed || !origin) return;
      const p = grabbed.position();
      const dx = p.x - origin.x;
      const dy = p.y - origin.y;
      for (const m of extras) m.n.position({ x: m.x + dx, y: m.y + dy });
    };
    const onFree = (e: any) => {
      if (e.target !== grabbed) return;
      if (extras.length) {
        useGraphStore
          .getState()
          .queuePositions(extras.map((m) => ({ id: m.n.id(), x: m.n.position('x'), y: m.n.position('y') })));
      }
      grabbed = null;
      origin = null;
      extras = [];
    };

    cy.on('grab', 'node.group', onGrab);
    cy.on('drag', 'node.group', onDrag);
    cy.on('free', 'node.group', onFree);
    return () => {
      cy.off('grab', 'node.group', onGrab);
      cy.off('drag', 'node.group', onDrag);
      cy.off('free', 'node.group', onFree);
    };
  }, [handle]);
}
