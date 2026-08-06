import { useEffect } from 'react';
import { useGraphStore } from '../../state/store';
import { resolveLocationHit } from './hitTest';
import type { CanvasHandle } from './handle';

/** Taps, double-taps, and drag-persistence. Everything structural (reconcile,
 *  layout, marquee, context menu) lives in its own hook. */
export function useCanvasEvents(handle: CanvasHandle | null) {
  useEffect(() => {
    if (!handle) return;
    const { cy } = handle;

    const onNodeTap = (ev: any) => {
      const node = ev.target;
      const store = useGraphStore.getState();
      store.closeContextMenu();
      if (node.hasClass('handle')) return;
      if (node.hasClass('group')) {
        /* locations and connections always outrank a grouping: redirect the
           tap if anything is really under the pointer (a shape's dead corner,
           a name plate that has grown past its box, an ephemeral stub, …) */
        const hit = resolveLocationHit(handle, ev.position);
        if (hit?.hasClass('portal')) {
          store.selectConnection(hit.data('connectionId'));
          return;
        }
        if (hit && store.mode === 'connect') {
          void store.handleConnectClick(hit.id());
          return;
        }
        if (hit) {
          store.selectLocation(hit.id());
          return;
        }
        store.selectGroup(node.data('groupId'));
        return;
      }
      if (node.hasClass('portal')) {
        store.selectConnection(node.data('connectionId'));
        return;
      }
      if (store.mode === 'connect') {
        void store.handleConnectClick(node.id());
        return;
      }
      store.selectLocation(node.id());
    };

    const onEdgeTap = (ev: any) => {
      const store = useGraphStore.getState();
      store.closeContextMenu();
      store.selectConnection(ev.target.data('connectionId') ?? ev.target.id());
    };

    const onCoreTap = (ev: any) => {
      if (ev.target !== cy) return;
      const store = useGraphStore.getState();
      store.closeContextMenu();
      if (store.mode === 'add-location') {
        void store.createLocationAt(ev.position.x, ev.position.y);
        return;
      }
      if (store.mode === 'connect') {
        store.cancelConnect();
        return;
      }
      cy.elements().unselect();
      store.select(null);
    };

    const onDblClick = (ev: any) => void useGraphStore.getState().toggleVisited(ev.target.id());

    /* groupings, multi-selections and ephemeral stubs all persist their drags */
    const onDragFree = (ev: any) => {
      const node = ev.target;
      if (node.hasClass('handle') || node.hasClass('ghost')) return;
      const store = useGraphStore.getState();

      if (node.hasClass('group')) {
        /* descendants() reaches through nested sub-groupings too */
        const list = node
          .descendants('node.location')
          .map((n: any) => ({ id: n.id(), x: n.position().x, y: n.position().y }));
        store.queuePositions(list);
        handle.restack();
        return;
      }
      if (node.hasClass('portal')) {
        const anchor = cy.getElementById(node.data('anchorId'));
        if (anchor.empty()) return;
        const dx = node.position().x - anchor.position().x;
        const dy = node.position().y - anchor.position().y;
        node.data('offsetX', dx);
        node.data('offsetY', dy);
        store.queuePortalOffset(node.id(), dx, dy);
        return;
      }
      const selected = cy.nodes('.location:selected');
      if (node.selected() && selected.length > 1) {
        store.queuePositions(
          selected.map((n: any) => ({ id: n.id(), x: n.position().x, y: n.position().y }))
        );
      } else {
        store.queuePosition(node.id(), node.position().x, node.position().y);
      }
      /* only the grouping *footprints* can have changed — room order depends
         on area/off-plane coordinate, neither of which a drag changes */
      handle.restack({ rooms: false });
    };

    cy.on('tap', 'node', onNodeTap);
    cy.on('tap', 'edge', onEdgeTap);
    cy.on('tap', onCoreTap);
    cy.on('dblclick', 'node.location', onDblClick);
    cy.on('dragfree', 'node', onDragFree);

    return () => {
      cy.off('tap', 'node', onNodeTap);
      cy.off('tap', 'edge', onEdgeTap);
      cy.off('tap', onCoreTap);
      cy.off('dblclick', 'node.location', onDblClick);
      cy.off('dragfree', 'node', onDragFree);
    };
  }, [handle]);
}
