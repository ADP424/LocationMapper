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

    /**
     * While a picker is armed the canvas is a chooser and nothing else: a tap
     * answers the request. It never changes the selection, never advances a
     * connect step, and never deselects — the panel that asked the question is
     * still open behind it, and must stay that way.
     *
     * Returns true when the tap was consumed.
     */
    const answerPick = (ev: any): boolean => {
      const store = useGraphStore.getState();
      const pick = store.pick;
      if (!pick) return false;
      const node = ev.target;
      store.closeContextMenu();

      if (node.hasClass('handle') || node.hasClass('ghost')) return true;

      if (node.hasClass('portal')) {
        store.resolvePick('connection', node.data('connectionId'));
        return true;
      }

      if (node.hasClass('group')) {
        /* same redirect as a normal tap: a room, a name plate or a stub under
           the pointer outranks the grouping body it happens to sit on */
        const hit = resolveLocationHit(handle, ev.position);
        if (hit?.hasClass('portal')) store.resolvePick('connection', hit.data('connectionId'));
        else if (hit && pick.kind !== 'group') store.resolvePick('location', hit.id());
        else store.resolvePick('group', node.data('groupId'));
        return true;
      }

      /* clicking a room while picking a grouping means "the one around it" */
      if (pick.kind === 'group') {
        const parent = node.parent();
        if (parent.nonempty() && parent.data('groupId')) {
          store.resolvePick('group', parent.data('groupId'));
          return true;
        }
      }

      store.resolvePick('location', node.id());
      return true;
    };

    const onNodeTap = (ev: any) => {
      if (answerPick(ev)) return;

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
      const cid = ev.target.data('connectionId') ?? ev.target.id();
      if (store.pick) {
        store.resolvePick('connection', cid);
        return;
      }
      store.selectConnection(cid);
    };

    const onCoreTap = (ev: any) => {
      if (ev.target !== cy) return;
      const store = useGraphStore.getState();
      store.closeContextMenu();

      /* empty space means "never mind" — same as it does for connect mode */
      if (store.pick) {
        store.cancelPick();
        return;
      }
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

    const onDblClick = (ev: any) => {
      /* the first tap already answered a pick; don't also flip Visited */
      if (useGraphStore.getState().pick) return;
      void useGraphStore.getState().toggleVisited(ev.target.id());
    };

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
        handle.sync();
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
        /* a stub dragged into open space really does move the drawn extent */
        handle.sync({ rooms: false });
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
      handle.sync({ rooms: false });
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
