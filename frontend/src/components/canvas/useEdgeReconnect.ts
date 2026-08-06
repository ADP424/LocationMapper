import type { NodeSingular } from 'cytoscape';
import { useEffect } from 'react';
import { portalEdgeId } from '../../graph/elements';
import { useGraphStore } from '../../state/store';
import type { Connection, Selection } from '../../types';
import { locationAt, nearestLocation, pushOut } from './hitTest';
import type { CanvasHandle } from './handle';

const HANDLE_SOURCE = '__handle-source__';
const HANDLE_TARGET = '__handle-target__';
const RECONNECT_EDGE = '__reconnect-edge__';

/** Draggable amber endpoints for the selected connection. */
export function useEdgeReconnect(
  handle: CanvasHandle | null,
  selection: Selection | null,
  connections: Record<string, Connection>
) {
  useEffect(() => {
    if (!handle) return;
    const { cy, scaler, connIndexRef } = handle;

    const cleanup = () => {
      cy.getElementById(RECONNECT_EDGE).remove();
      cy.nodes('.handle').remove();
      cy.edges().removeClass('reconnecting');
      cy.nodes('.drop-target').removeClass('drop-target');
    };
    cleanup();

    if (!selection || selection.type !== 'connection') return;
    const conn = connections[selection.id];
    if (!conn) return;

    const srcEdge = cy.getElementById(conn.ephemeral ? portalEdgeId(conn.id, 'out') : conn.id);
    const tgtEdge = cy.getElementById(conn.ephemeral ? portalEdgeId(conn.id, 'in') : conn.id);
    const srcNode = cy.getElementById(conn.sourceId);
    const tgtNode = cy.getElementById(conn.targetId);
    if (srcEdge.empty() || tgtEdge.empty() || srcNode.empty() || tgtNode.empty()) return;

    let dragging = false;
    let pointer: { x: number; y: number } | null = null;

    const points = () => ({
      source: pushOut((srcEdge as any).sourceEndpoint(), srcNode.position()),
      target: pushOut((tgtEdge as any).targetEndpoint(), tgtNode.position())
    });

    const place = () => {
      if (dragging) return;
      const p = points();
      const sh = cy.getElementById(HANDLE_SOURCE);
      const th = cy.getElementById(HANDLE_TARGET);
      if (sh.nonempty()) sh.position(p.source);
      if (th.nonempty()) th.position(p.target);
    };

    const start = points();
    const handles = cy.add([
      {
        group: 'nodes',
        data: { id: HANDLE_SOURCE, end: 'source', connectionId: conn.id, w: 18, h: 18 },
        position: start.source,
        classes: 'handle',
        selectable: false,
        grabbable: true
      },
      {
        group: 'nodes',
        data: { id: HANDLE_TARGET, end: 'target', connectionId: conn.id, w: 18, h: 18 },
        position: start.target,
        classes: 'handle',
        selectable: false,
        grabbable: true
      }
    ]);
    scaler.applyTo(handles);

    /* the cursor is a far better drop probe than the handle's centre */
    const resolveDrop = (h: any): NodeSingular | null => {
      const probes = [pointer, h.position()].filter(Boolean) as Array<{ x: number; y: number }>;
      for (const p of probes) {
        const hit = locationAt(cy, p);
        if (hit) return hit;
      }
      for (const p of probes) {
        const near = nearestLocation(cy, p, 55);
        if (near) return near;
      }
      return null;
    };

    const onPointer = (ev: any) => {
      pointer = ev.position;
    };

    const onGrab = (ev: any) => {
      dragging = true;
      const h = ev.target;
      const end = h.data('end') as 'source' | 'target';
      const anchorId = end === 'source' ? conn.targetId : conn.sourceId;
      const idx = connIndexRef.current.get(conn.id) ?? cy.collection();
      idx.addClass('reconnecting');
      const reconnectEdge = cy.add({
        group: 'edges',
        data: {
          id: RECONNECT_EDGE,
          lineWidth: 3,
          source: end === 'source' ? h.id() : anchorId,
          target: end === 'source' ? anchorId : h.id()
        },
        classes: 'reconnect-edge',
        selectable: false
      });
      scaler.applyTo(reconnectEdge);
    };

    const onDrag = (ev: any) => {
      pointer = ev.position ?? pointer;
      cy.nodes('.drop-target').removeClass('drop-target');
      const hit = resolveDrop(ev.target);
      if (hit) hit.addClass('drop-target');
    };

    const onFree = (ev: any) => {
      if (!dragging) return;
      const h = ev.target;
      const end = h.data('end') as 'source' | 'target';
      const hit = resolveDrop(h);

      cy.getElementById(RECONNECT_EDGE).remove();
      const idx = connIndexRef.current.get(conn.id) ?? cy.collection();
      idx.removeClass('reconnecting');
      cy.nodes('.drop-target').removeClass('drop-target');
      dragging = false;

      const current = end === 'source' ? conn.sourceId : conn.targetId;
      const other = end === 'source' ? conn.targetId : conn.sourceId;

      if (!hit || hit.id() === current) {
        place(); // dropped on nothing (or back home) -> snap back
        return;
      }
      if (hit.id() === other) {
        place();
        useGraphStore.getState().setStatus('A Connection Needs Two Different Rooms');
        return;
      }

      void useGraphStore
        .getState()
        .updateConnection(conn.id, end === 'source' ? { sourceId: hit.id() } : { targetId: hit.id() });
    };

    /* only the two rooms this edge is attached to can move its handles — the
       old code listened for `position` on every node in the graph */
    srcNode.on('position', place);
    tgtNode.on('position', place);
    cy.on('mousemove', onPointer);
    cy.on('grab', 'node.handle', onGrab);
    cy.on('drag', 'node.handle', onDrag);
    cy.on('free', 'node.handle', onFree);

    return () => {
      srcNode.off('position', undefined, place);
      tgtNode.off('position', undefined, place);
      cy.off('mousemove', onPointer);
      cy.off('grab', 'node.handle', onGrab);
      cy.off('drag', 'node.handle', onDrag);
      cy.off('free', 'node.handle', onFree);
      cleanup();
    };
  }, [handle, selection, connections]);
}
