import type { NodeSingular } from 'cytoscape';
import { useEffect } from 'react';
import type { CanvasHandle } from './handle';

/**
 * Ephemeral stubs are anchored to their room and travel with it. This used to
 * be `cy.nodes('node.portal[anchorId = "…"]')` — a full selector scan of the
 * graph on *every* position event, which during an animated layout is once
 * per node per frame (O(N^2) per frame on the main thread). Instead, the
 * anchor->stub map is built once per structural change and kept in step.
 */
export function usePortalFollow(handle: CanvasHandle | null, elements: unknown) {
  useEffect(() => {
    if (!handle) return;
    const { cy } = handle;

    const portalsByAnchor = new Map<string, NodeSingular[]>();
    const rebuildIndex = () => {
      portalsByAnchor.clear();
      cy.nodes('.portal').forEach((p) => {
        const a = p.data('anchorId') as string;
        const list = portalsByAnchor.get(a);
        if (list) list.push(p as unknown as NodeSingular);
        else portalsByAnchor.set(a, [p as unknown as NodeSingular]);
      });
    };
    rebuildIndex();

    const follow = (ev: any) => {
      const node = ev.target as NodeSingular;
      const stubs = portalsByAnchor.get(node.id());
      if (!stubs) return;
      const p = node.position();
      for (const s of stubs) {
        s.position({ x: p.x + (s.data('offsetX') ?? 0), y: p.y + (s.data('offsetY') ?? 0) });
      }
    };
    cy.on('position drag', 'node.location', follow);
    cy.on('add remove', 'node.portal', rebuildIndex);

    return () => {
      cy.off('position drag', 'node.location', follow);
      cy.off('add remove', 'node.portal', rebuildIndex);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, elements]);
}
