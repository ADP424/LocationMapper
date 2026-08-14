import { useEffect } from 'react';
import type { RefObject } from 'react';
import { useGraphStore } from '../../state/store';
import { resolveLocationHit } from './hitTest';
import type { CanvasHandle } from './handle';

/** Binds the right-click triggers that open the context menu. The menu's
 *  *entries* are computed separately (`useMenuEntries`), since they depend on
 *  store slices that change far more often than these bindings need to. */
export function useContextMenu(handle: CanvasHandle | null, containerRef: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    if (!handle || !containerRef.current) return;
    const { cy, suppressMenuRef } = handle;
    const container = containerRef.current;

    const menuPoint = (ev: any) => {
      const oe = ev.originalEvent as MouseEvent | undefined;
      const rect = container.getBoundingClientRect();
      return {
        x: oe?.clientX ?? rect.left,
        y: oe?.clientY ?? rect.top,
        graphX: ev.position?.x ?? 0,
        graphY: ev.position?.y ?? 0
      };
    };

    const onCore = (ev: any) => {
      if (ev.target !== cy || suppressMenuRef.current) return;
      useGraphStore.getState().openContextMenu(menuPoint(ev));
    };

    const onLocation = (ev: any) => {
      if (suppressMenuRef.current) return;
      useGraphStore.getState().openContextMenu({ ...menuPoint(ev), locationId: ev.target.id() });
    };

    const onGroup = (ev: any) => {
      if (suppressMenuRef.current) return;
      const store = useGraphStore.getState();
      /* same redirect as the tap handler: a grouping's context menu only opens
         when nothing else (room, name plate, ephemeral stub) is under the point */
      const hit = resolveLocationHit(handle, ev.position);
      if (hit?.hasClass('portal')) {
        const cid = hit.data('connectionId');
        /* while picking, right-clicking must not retarget the panel that asked */
        if (!store.pick) store.selectConnection(cid);
        store.openContextMenu({ ...menuPoint(ev), connectionId: cid });
      } else if (hit) {
        store.openContextMenu({ ...menuPoint(ev), locationId: hit.id() });
      } else {
        store.openContextMenu({ ...menuPoint(ev), groupId: ev.target.data('groupId') });
      }
    };

    const onConnection = (ev: any) => {
      if (suppressMenuRef.current) return;
      const store = useGraphStore.getState();
      const cid = ev.target.data('connectionId') ?? ev.target.id();
      if (!store.pick) store.selectConnection(cid);
      store.openContextMenu({ ...menuPoint(ev), connectionId: cid });
    };

    cy.on('cxttap', onCore);
    cy.on('cxttap', 'node.location', onLocation);
    cy.on('cxttap', 'node.group', onGroup);
    cy.on('cxttap', 'node.portal, edge', onConnection);

    return () => {
      cy.off('cxttap', onCore);
      cy.off('cxttap', 'node.location', onLocation);
      cy.off('cxttap', 'node.group', onGroup);
      cy.off('cxttap', 'node.portal, edge', onConnection);
    };
  }, [handle, containerRef]);
}
