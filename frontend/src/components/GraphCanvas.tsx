import cytoscape, { Core, ElementDefinition } from 'cytoscape';
import elk from 'cytoscape-elk';
import fcose from 'cytoscape-fcose';
import { useEffect, useMemo, useRef } from 'react';
import { cyHolder } from '../graph/cyHolder';
import { buildElements } from '../graph/elements';
import { layoutOptions } from '../graph/layouts';
import { graphStyle } from '../graph/style';
import { useGraphStore } from '../state/store';
import type { Selection } from '../types';
import ContextMenu, { MenuItem } from './ContextMenu';

const GHOST_NODE = '__ghost__';
const GHOST_EDGE = '__ghost-edge__';
const isInternal = (id: string) => id.startsWith('__');

let extensionsRegistered = false;
function registerExtensions() {
  if (extensionsRegistered) return;
  cytoscape.use(fcose);
  cytoscape.use(elk);
  extensionsRegistered = true;
}

/** Reconcile the scene graph. `fullReset` wipes everything first (map switch). */
function syncGraph(
  cy: Core,
  desired: ElementDefinition[],
  fullReset: boolean,
  fallbackPosition: { x: number; y: number }
) {
  cy.batch(() => {
    if (fullReset) {
      cy.elements().remove();
      cy.add(
        desired.map((el) =>
          el.group === 'edges' || !('position' in el) || el.position
            ? el
            : { ...el, position: { ...fallbackPosition } }
        )
      );
      return;
    }

    const wanted = new Map<string, ElementDefinition>();
    for (const el of desired) wanted.set(String(el.data!.id), el);

    const stale = cy
      .elements()
      .filter((el) => !isInternal(el.id()) && !wanted.has(el.id()));
    if (stale.nonempty()) cy.remove(stale);

    const toAdd: ElementDefinition[] = [];
    wanted.forEach((el, id) => {
      const existing = cy.getElementById(id);
      if (existing.empty()) {
        toAdd.push(
          el.position ? el : { ...el, position: { ...fallbackPosition } }
        );
        return;
      }
      existing.data(el.data!);
      existing.classes(typeof el.classes === 'string' ? el.classes : '');
      /* the store is the source of truth for geometry, except mid-drag */
      if (existing.isNode() && el.position && !existing.grabbed()) {
        const p = existing.position();
        if (Math.abs(p.x - el.position.x) > 0.5 || Math.abs(p.y - el.position.y) > 0.5) {
          existing.position(el.position);
        }
      }
    });
    if (toAdd.length) cy.add(toAdd);
  });
}

function applyHighlight(cy: Core, selection: Selection | null) {
  cy.batch(() => {
    cy.elements().removeClass('hl-primary hl-neighbor faded');
    if (!selection) return;

    const primary =
      selection.type === 'location'
        ? cy.getElementById(selection.id)
        : cy.elements(`[connectionId = "${selection.id}"]`);
    if (primary.empty()) return;

    let nbh = primary.closedNeighborhood();

    /* ephemeral links are detached: pull in the sibling stub + far location */
    nbh.filter('node.portal').forEach((p) => {
      const cid = p.data('connectionId');
      if (cid) nbh = nbh.union(cy.elements(`[connectionId = "${cid}"]`));
    });
    nbh = nbh.union(nbh.filter('node.portal').neighborhood());

    const keep = nbh.union(primary);
    cy.elements().difference(keep).addClass('faded');
    nbh.addClass('hl-neighbor');
    primary.removeClass('hl-neighbor').addClass('hl-primary');
  });
}

export default function GraphCanvas() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const lastMapRef = useRef<string | null>(null);

  const locations = useGraphStore((s) => s.locations);
  const connections = useGraphStore((s) => s.connections);
  const pendingPositions = useGraphStore((s) => s.pendingPositions);
  const selection = useGraphStore((s) => s.selection);
  const labelMode = useGraphStore((s) => s.labelMode);
  const groupByLayer = useGraphStore((s) => s.groupByLayer);
  const layout = useGraphStore((s) => s.layout);
  const layoutNonce = useGraphStore((s) => s.layoutNonce);
  const mode = useGraphStore((s) => s.mode);
  const pendingSource = useGraphStore((s) => s.pendingSource);
  const mapId = useGraphStore((s) => s.mapId);
  const contextMenu = useGraphStore((s) => s.contextMenu);

  const elements = useMemo(
    () =>
      buildElements(Object.values(locations), Object.values(connections), {
        labelMode,
        groupByLayer,
        positionOverrides: pendingPositions
      }),
    [locations, connections, labelMode, groupByLayer, pendingPositions]
  );

  /* ---------------------------------------------------------- create once */
  useEffect(() => {
    if (!containerRef.current) return;
    registerExtensions();

    const cy = cytoscape({
      container: containerRef.current,
      style: graphStyle,
      elements: [],
      /* keep edges painted while panning / zooming */
      hideEdgesOnViewport: false,
      textureOnViewport: false,
      motionBlur: false,
      wheelSensitivity: 0.85,
      minZoom: 0.04,
      maxZoom: 4,
      selectionType: 'single',
      boxSelectionEnabled: false
    });

    cyRef.current = cy;
    cyHolder.cy = cy;

    cy.on('tap', 'node', (ev) => {
      const node = ev.target;
      const store = useGraphStore.getState();
      store.closeContextMenu();
      if (node.hasClass('layer-group')) return;
      if (node.hasClass('portal')) {
        store.selectConnection(node.data('connectionId'));
        return;
      }
      if (store.mode === 'connect') {
        void store.handleConnectClick(node.id());
        return;
      }
      store.selectLocation(node.id());
    });

    cy.on('tap', 'edge', (ev) => {
      const store = useGraphStore.getState();
      store.closeContextMenu();
      store.selectConnection(ev.target.data('connectionId') ?? ev.target.id());
    });

    cy.on('tap', (ev) => {
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
      store.select(null);
    });

    cy.on('dblclick', 'node.location', (ev) => {
      void useGraphStore.getState().toggleVisited(ev.target.id());
    });

    cy.on('dragfree', 'node', (ev) => {
      const node = ev.target;
      if (node.hasClass('portal') || node.hasClass('layer-group')) return;
      const { x, y } = node.position();
      useGraphStore.getState().queuePosition(node.id(), x, y);
    });

    /* ------------------------------------------------- context menus ---- */
    const menuPoint = (ev: any) => {
      const rect = containerRef.current!.getBoundingClientRect();
      const oe = ev.originalEvent as MouseEvent | undefined;
      return {
        x: (oe?.clientX ?? rect.left) - rect.left,
        y: (oe?.clientY ?? rect.top) - rect.top,
        graphX: ev.position?.x ?? 0,
        graphY: ev.position?.y ?? 0
      };
    };

    cy.on('cxttap', (ev) => {
      if (ev.target !== cy) return;
      useGraphStore.getState().openContextMenu(menuPoint(ev));
    });

    cy.on('cxttap', 'node.location', (ev) => {
      useGraphStore
        .getState()
        .openContextMenu({ ...menuPoint(ev), locationId: ev.target.id() });
    });

    cy.on('cxttap', 'node.portal, edge', (ev) => {
      const store = useGraphStore.getState();
      store.selectConnection(ev.target.data('connectionId') ?? ev.target.id());
      store.openContextMenu(menuPoint(ev));
    });

    return () => {
      cyHolder.cy = null;
      cyRef.current = null;
      cy.destroy();
    };
  }, []);

  /* ---------------------------------------------- reconcile the elements */
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const fullReset = lastMapRef.current !== mapId;
    lastMapRef.current = mapId;

    const extent = cy.extent();
    const centre = {
      x: (extent.x1 + extent.x2) / 2,
      y: (extent.y1 + extent.y2) / 2
    };

    syncGraph(cy, elements, fullReset, centre);
    applyHighlight(cy, selection);
  }, [elements, selection, mapId]);

  /* ------------------------------------------------------ run the layout */
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || cy.nodes().length === 0) return;

    const run = cy.layout(layoutOptions(layout, cy.nodes().length));

    run.one('layoutstop', () => {
      if (layout === 'preset') {
        cy.fit(undefined, 60);
        return;
      }
      void useGraphStore.getState().persistLayoutPositions(
        cy.nodes('.location').map((n) => ({
          id: n.id(),
          x: n.position().x,
          y: n.position().y
        }))
      );
    });

    run.run();
    return () => {
      run.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutNonce, mapId, groupByLayer]);

  /* --------------------------------- rubber band while creating an edge */
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    const removeGhost = () => {
      cy.getElementById(GHOST_EDGE).remove();
      cy.getElementById(GHOST_NODE).remove();
    };

    cy.nodes('.connect-source').removeClass('connect-source');
    removeGhost();

    if (mode !== 'connect' || !pendingSource) return;
    const source = cy.getElementById(pendingSource);
    if (source.empty()) return;

    source.addClass('connect-source');
    const p = source.position();
    cy.add([
      {
        group: 'nodes',
        data: { id: GHOST_NODE },
        position: { x: p.x + 60, y: p.y + 60 },
        selectable: false,
        grabbable: false,
        classes: 'ghost'
      },
      {
        group: 'edges',
        data: { id: GHOST_EDGE, source: pendingSource, target: GHOST_NODE },
        selectable: false,
        classes: 'ghost-edge'
      }
    ]);

    const onMove = (ev: any) => {
      const ghost = cy.getElementById(GHOST_NODE);
      if (ghost.nonempty()) ghost.position(ev.position);
    };
    cy.on('mousemove', onMove);

    return () => {
      cy.off('mousemove', onMove);
      cy.nodes('.connect-source').removeClass('connect-source');
      removeGhost();
    };
  }, [mode, pendingSource]);

  /* ---------------------------------------------------------- menu items */
  const menuItems: MenuItem[] = useMemo(() => {
    const store = useGraphStore.getState();
    if (!contextMenu) return [];
    if (contextMenu.locationId) {
      const id = contextMenu.locationId;
      const loc = locations[id];
      return [
        { label: '+ Create Connection', onSelect: () => store.startConnectionFrom(id) },
        { label: 'Inspect Location', onSelect: () => store.selectLocation(id) },
        {
          label: loc?.visited ? 'Mark As Not Visited' : 'Mark As Visited',
          onSelect: () => void store.toggleVisited(id)
        },
        {
          label: 'Delete Location',
          danger: true,
          onSelect: () => {
            if (confirm('Delete this location and all of its connections?')) {
              void store.deleteLocation(id);
            }
          }
        }
      ];
    }
    return [
      {
        label: '+ Create Room',
        onSelect: () => void store.createLocationAt(contextMenu.graphX, contextMenu.graphY)
      },
      { label: 'Re-Layout Graph', onSelect: () => store.runLayout() },
      { label: 'Fit To Screen', onSelect: () => cyRef.current?.fit(undefined, 60) }
    ];
  }, [contextMenu, locations]);

  const closeMenu = useGraphStore((s) => s.closeContextMenu);

  return (
    <div
      className={`graph-canvas mode-${mode}`}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div ref={containerRef} className="cy-host" />

      {mode !== 'select' && (
        <div className="canvas-hint">
          {mode === 'add-location'
            ? 'Click Anywhere To Place A New Location (Esc To Cancel)'
            : pendingSource
              ? 'Drag To The Destination And Click It (Esc To Cancel)'
              : 'Click The Source Location (Esc To Cancel)'}
        </div>
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={menuItems}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}
