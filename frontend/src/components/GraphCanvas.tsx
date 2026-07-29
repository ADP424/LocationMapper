import cytoscape, { Core, ElementDefinition, NodeSingular } from 'cytoscape';
import elk from 'cytoscape-elk';
import fcose from 'cytoscape-fcose';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cyHolder } from '../graph/cyHolder';
import { buildElements, groupNodeId, isInternalId, parsePortalId } from '../graph/elements';
import { computeCoordinateLayout } from '../graph/coordinateLayout';
import { computeGroupedLayout } from '../graph/groupLayout';
import { descendantGroupIds, buildGroupTree } from '../graph/groups';
import { COORDINATE_LAYOUTS, computeMetrics, isCoordinateLayout, layoutOptions } from '../graph/layouts';
import type { RoutePlan } from '../graph/pathfinding';
import { graphStyle } from '../graph/style';
import { applyViewScale, viewScaleFactor } from '../graph/viewScale';
import { useGraphStore } from '../state/store';
import type { PortalOffset, Selection } from '../types';
import GraphScrollbars from './GraphScrollbars';
import MenuPanel, { type MenuEntry } from './Menu';
import { groupMenuEntries } from './GroupPicker';

const GHOST_NODE = '__ghost__';
const GHOST_EDGE = '__ghost-edge__';
const HANDLE_SOURCE = '__handle-source__';
const HANDLE_TARGET = '__handle-target__';
const RECONNECT_EDGE = '__reconnect-edge__';
/** How far outside the room the drag handle floats, so it never overlaps it. */
const HANDLE_OFFSET = 18;

let extensionsRegistered = false;
function registerExtensions() {
  if (extensionsRegistered) return;
  cytoscape.use(fcose);
  cytoscape.use(elk);
  extensionsRegistered = true;
}

function refreshRendering(cy: Core) {
  cy.style().update();
  cy.forceRender();
}

/** wheelSensitivity is an init option; the renderer reads it per event. */
function setWheelSensitivity(cy: Core, value: number) {
  try {
    const renderer = (cy as any).renderer?.();
    if (renderer) renderer.wheelSensitivity = value;
  } catch {
    /* private API — ignore if the internals ever move */
  }
}

/**
 * A layout moves stubs as plain nodes; their offset is the thing we persist, so
 * recompute it from where they ended up (keeps the live "follow the room"
 * behaviour correct until the next rebuild).
 */
function rebaseStubOffsets(cy: Core) {
  cy.batch(() => {
    cy.nodes('.portal').forEach((p) => {
      const anchor = cy.getElementById(p.data('anchorId'));
      if (anchor.empty()) return;
      const a = anchor.position();
      const s = p.position();
      p.data('offsetX', s.x - a.x);
      p.data('offsetY', s.y - a.y);
    });
  });
}

const IMMUTABLE = new Set(['id', 'source', 'target', 'parent']);
function mutableData(data: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (!IMMUTABLE.has(k)) out[k] = v;
  return out;
}

function syncGraph(
  cy: Core,
  desired: ElementDefinition[],
  fullReset: boolean,
  fallbackPosition: { x: number; y: number }
): boolean {
  const withFallback = (el: ElementDefinition) =>
    el.data?.source || el.position || el.data?.kind === 'group'
      ? el
      : { ...el, position: { ...fallbackPosition } };

  if (fullReset) {
    cy.elements().remove();
    cy.add(desired.map(withFallback));
    return true;
  }

  let structural = false;
  cy.batch(() => {
    const wanted = new Map<string, ElementDefinition>();
    for (const el of desired) wanted.set(String(el.data!.id), el);

    const stale = cy.elements().filter((el) => !isInternalId(el.id()) && !wanted.has(el.id()));
    if (stale.nonempty()) {
      cy.remove(stale);
      structural = true;
    }

    const toAdd: ElementDefinition[] = [];
    wanted.forEach((el, id) => {
      const existing = cy.getElementById(id);
      if (existing.empty()) {
        toAdd.push(withFallback(el));
        return;
      }

      /* Cytoscape cannot re-point an existing edge: rebuild it instead.
         (This is what made endpoint re-attachment look like a no-op.) */
      if (existing.isEdge()) {
        const d = el.data as any;
        if (existing.source().id() !== d.source || existing.target().id() !== d.target) {
          cy.remove(existing);
          toAdd.push(el);
          structural = true;
          return;
        }
      }

      const previousParent = existing.isNode()
        ? (existing.parent().first().id() as string | undefined) ?? undefined
        : undefined;
      existing.data(mutableData(el.data as Record<string, unknown>));
      existing.classes(typeof el.classes === 'string' ? el.classes : '');

      /* locations, ephemeral stubs AND sub-groupings all follow data.parent so
         that nesting (including grouping-inside-grouping) stays in sync */
      if (
        existing.isNode() &&
        !existing.grabbed() &&
        !existing.hasClass('ghost') &&
        !existing.hasClass('handle')
      ) {
        const nextParent = (el.data as any).parent as string | undefined;
        if (previousParent !== nextParent) existing.move({ parent: nextParent ?? null });
      }
      if (existing.isNode() && el.position && !existing.grabbed()) {
        const p = existing.position();
        if (Math.abs(p.x - el.position.x) > 0.5 || Math.abs(p.y - el.position.y) > 0.5) {
          existing.position(el.position);
        }
      }
    });
    if (toAdd.length) {
      cy.add(toAdd);
      structural = true;
    }
  });
  return structural;
}

function applyHighlight(
  cy: Core,
  selection: Selection | null,
  multi: string[],
  labelMembers: string[] = [],
  route: RoutePlan | null = null,
  waypoints: string[] = []
) {
  cy.batch(() => {
    cy.elements().removeClass(
      'hl-primary hl-neighbor faded route-node route-edge route-start route-stop route-end'
    );

    /* a planned trip owns the view: everything off-route is dimmed */
    if (route && (route.locationIds.length || route.connectionIds.length)) {
      const wantedNodes = new Set(route.locationIds);
      const wantedEdges = new Set(route.connectionIds);
      const nodes = cy.nodes('.location').filter((n) => wantedNodes.has(n.id()));
      const routeEles = cy.elements().filter((el) => wantedEdges.has(el.data('connectionId')));
      const keep = nodes
        .union(routeEles)
        .union(routeEles.connectedNodes())
        .union(nodes.parents())
        .union(routeEles.nodes().parents());

      cy.elements().difference(keep).addClass('faded');
      nodes.addClass('route-node');
      routeEles.edges().addClass('route-edge');
      routeEles.nodes('.portal').addClass('route-node');

      /* rooms visited only to unlock a gate, not because they were asked for */
      route.detourIds.forEach((id) => cy.getElementById(id).addClass('route-stop'));

      waypoints.forEach((id, i) => {
        const n = cy.getElementById(id);
        if (n.empty()) return;
        n.addClass(i === 0 ? 'route-start' : i === waypoints.length - 1 ? 'route-end' : 'route-stop');
      });

      /* keep whatever is selected readable on top of the route */
      if (selection?.type === 'location') {
        cy.getElementById(selection.id).removeClass('faded').addClass('hl-primary');
      } else if (selection?.type === 'connection') {
        cy.elements(`[connectionId = "${selection.id}"]`).removeClass('faded').addClass('hl-primary');
      }
      return;
    }

    if (multi.length > 1) return;
    if (!selection) return;

    if (selection.type === 'location-label' || selection.type === 'connection-label') {
      const members = new Set(labelMembers);
      const primary =
        selection.type === 'location-label'
          ? cy.nodes('.location').filter((n) => members.has(n.id()))
          : cy.elements().filter((el) => members.has(el.data('connectionId')));
      if (primary.empty()) return;
      const keep = primary
        .union(primary.connectedEdges())
        .union(primary.connectedEdges().connectedNodes())
        .union(primary.nodes().parents());
      cy.elements().difference(keep).addClass('faded');
      keep.difference(primary).addClass('hl-neighbor');
      primary.addClass('hl-primary');
      return;
    }

    let primary =
      selection.type === 'location'
        ? cy.getElementById(selection.id)
        : selection.type === 'connection'
          ? cy.elements(`[connectionId = "${selection.id}"]`)
          : cy.getElementById(groupNodeId(selection.id));

    if (primary.empty()) return;

    let nbh =
      selection.type === 'group'
        ? (() => {
            const members = primary.descendants();
            const edges = members.connectedEdges();
            return members.union(edges).union(edges.connectedNodes());
          })()
        : primary.closedNeighborhood();

    nbh.filter('node.portal').forEach((p) => {
      const cid = p.data('connectionId');
      if (cid) nbh = nbh.union(cy.elements(`[connectionId = "${cid}"]`));
    });
    nbh = nbh.union(nbh.filter('node.portal').neighborhood());
    nbh = nbh.union(nbh.nodes().parents());

    const keep = nbh.union(primary);
    cy.elements().difference(keep).addClass('faded');
    nbh.addClass('hl-neighbor');
    primary.removeClass('hl-neighbor').addClass('hl-primary');
  });
}

/* ------------------------------------------------------------ hit testing */
function locationAt(cy: Core, pos: { x: number; y: number }): NodeSingular | null {
  let best: NodeSingular | null = null;
  let bestArea = Infinity;
  cy.nodes('.location').forEach((n) => {
    const bb = n.boundingBox();
    if (pos.x < bb.x1 || pos.x > bb.x2 || pos.y < bb.y1 || pos.y > bb.y2) return;
    const area = bb.w * bb.h;
    if (area < bestArea) {
      bestArea = area;
      best = n;
    }
  });
  return best;
}

function nearestLocation(cy: Core, pos: { x: number; y: number }, maxDist: number) {
  let best: NodeSingular | null = null;
  let bestDist = Infinity;
  cy.nodes('.location').forEach((n) => {
    const bb = n.boundingBox();
    const dx = Math.max(bb.x1 - pos.x, 0, pos.x - bb.x2);
    const dy = Math.max(bb.y1 - pos.y, 0, pos.y - bb.y2);
    const d = Math.hypot(dx, dy);
    if (d < bestDist) {
      bestDist = d;
      best = n;
    }
  });
  return bestDist <= maxDist ? best : null;
}

/** Push a point away from a centre so the handle floats just outside the room. */
function pushOut(point: { x: number; y: number }, from: { x: number; y: number }) {
  const dx = point.x - from.x;
  const dy = point.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: point.x + (dx / len) * HANDLE_OFFSET, y: point.y + (dy / len) * HANDLE_OFFSET };
}

const renderedToModel = (cy: Core, x: number, y: number) => ({
  x: (x - cy.pan().x) / cy.zoom(),
  y: (y - cy.pan().y) / cy.zoom()
});

export default function GraphCanvas() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const lastMapRef = useRef<string | null>(null);
  const [cyReady, setCyReady] = useState(false);
  const factorRef = useRef(1);
  const settingsRef = useRef(useGraphStore.getState().settings);

  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(
    null
  );
  const marqueeBoxRef = useRef<typeof marquee>(null);
  const cxtStartRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const suppressMenuRef = useRef(false);

  const locations = useGraphStore((s) => s.locations);
  const connections = useGraphStore((s) => s.connections);
  const groups = useGraphStore((s) => s.groups);
  const locationLabels = useGraphStore((s) => s.locationLabels);
  const connectionLabels = useGraphStore((s) => s.connectionLabels);
  const pendingPositions = useGraphStore((s) => s.pendingPositions);
  const pendingPortalOffsets = useGraphStore((s) => s.pendingPortalOffsets);
  const selection = useGraphStore((s) => s.selection);
  const multiSelect = useGraphStore((s) => s.multiSelect);
  const labelMode = useGraphStore((s) => s.labelMode);
  const layout = useGraphStore((s) => s.layout);
  const layoutNonce = useGraphStore((s) => s.layoutNonce);
  const mode = useGraphStore((s) => s.mode);
  const pendingSource = useGraphStore((s) => s.pendingSource);
  const mapId = useGraphStore((s) => s.mapId);
  const contextMenu = useGraphStore((s) => s.contextMenu);
  const settings = useGraphStore((s) => s.settings);
  const routePlan = useGraphStore((s) => s.trip.plan);
  const waypoints = useGraphStore((s) => s.trip.waypoints);

  const labelNames = useMemo(
    () => ({
      locationLabelNames: Object.fromEntries(
        Object.values(locationLabels).map((l) => [l.id, l.name || 'Unnamed Label'])
      ),
      connectionLabelNames: Object.fromEntries(
        Object.values(connectionLabels).map((l) => [l.id, l.name || 'Unnamed Label'])
      )
    }),
    [locationLabels, connectionLabels]
  );

  const elements = useMemo(
    () =>
      buildElements(Object.values(locations), Object.values(connections), Object.values(groups), {
        labelMode,
        positionOverrides: pendingPositions,
        portalOffsetOverrides: pendingPortalOffsets,
        ...labelNames
      }),
    [locations, connections, groups, labelMode, pendingPositions, pendingPortalOffsets, labelNames]
  );

  /** Selecting a label highlights everything carrying it. */
  const labelMembers = useMemo(() => {
    if (selection?.type === 'location-label') {
      return Object.values(locations)
        .filter((l) => l.labelIds.includes(selection.id))
        .map((l) => l.id);
    }
    if (selection?.type === 'connection-label') {
      return Object.values(connections)
        .filter((c) => c.labelIds.includes(selection.id))
        .map((c) => c.id);
    }
    return [];
  }, [selection, locations, connections]);

  /* ---------------------------------------------------------- create once */
  useEffect(() => {
    if (!containerRef.current) return;
    registerExtensions();

    const cy = cytoscape({
      container: containerRef.current,
      style: graphStyle,
      elements: [],
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
    setCyReady(true);
    setWheelSensitivity(cy, settingsRef.current.scrollSensitivity);

    /* keep boxes/labels a constant size on screen while zooming */
    factorRef.current = viewScaleFactor(cy.zoom(), settingsRef.current);
    applyViewScale(cy, factorRef.current, settingsRef.current);

    let scaleFrame = 0;
    let scaleTimer: ReturnType<typeof setTimeout> | null = null;
    const refreshScale = () => {
      const f = viewScaleFactor(cy.zoom(), settingsRef.current);
      if (Math.abs(f - factorRef.current) / Math.max(factorRef.current, 0.0001) < 0.01) return;
      factorRef.current = f;
      applyViewScale(cy, f, settingsRef.current);
    };
    const onViewport = () => {
      /* huge graphs only re-scale once the wheel settles */
      if (cy.nodes().length > 4000) {
        if (scaleTimer) clearTimeout(scaleTimer);
        scaleTimer = setTimeout(refreshScale, 140);
        return;
      }
      if (scaleFrame) return;
      scaleFrame = requestAnimationFrame(() => {
        scaleFrame = 0;
        refreshScale();
      });
    };
    cy.on('viewport', onViewport);

    let fittedOnce = false;
    const ro = new ResizeObserver(() => {
      const el = containerRef.current;
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
      cy.resize();
      if (!fittedOnce && cy.nodes().length) {
        fittedOnce = true;
        applyViewScale(cy, 1, settingsRef.current);
        cy.fit(undefined, 60);
        factorRef.current = viewScaleFactor(cy.zoom(), settingsRef.current);
        applyViewScale(cy, factorRef.current, settingsRef.current);
      }
      cy.forceRender();
    });
    ro.observe(containerRef.current);

    cy.on('tap', 'node', (ev) => {
      const node = ev.target;
      const store = useGraphStore.getState();
      store.closeContextMenu();
      if (node.hasClass('handle')) return;
      if (node.hasClass('group')) {
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
      cy.elements().unselect();
      store.select(null);
    });

    cy.on('dblclick', 'node.location', (ev) => {
      void useGraphStore.getState().toggleVisited(ev.target.id());
    });

    /* ephemeral stubs are anchored to their room and travel with it */
    const followPortals = (node: any) => {
      const p = node.position();
      cy.nodes(`node.portal[anchorId = "${node.id()}"]`).forEach((portal: any) => {
        portal.position({
          x: p.x + (portal.data('offsetX') ?? 0),
          y: p.y + (portal.data('offsetY') ?? 0)
        });
      });
    };
    cy.on('position drag', 'node.location', (ev) => followPortals(ev.target));

    /* groupings, multi-selections and ephemeral stubs all persist their drags */
    cy.on('dragfree', 'node', (ev) => {
      const node = ev.target;
      if (node.hasClass('handle') || node.hasClass('ghost')) return;
      const store = useGraphStore.getState();
      const save = (n: any) => store.queuePosition(n.id(), n.position().x, n.position().y);

      if (node.hasClass('group')) {
        /* descendants() reaches through nested sub-groupings too */
        node.descendants('node.location').forEach(save);
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
      if (node.selected() && selected.length > 1) selected.forEach(save);
      else save(node);
    });

    /* ------------------------------------- right-drag marquee selection */
    cy.on('cxttapstart', (ev) => {
      suppressMenuRef.current = false;
      if (ev.target !== cy) {
        cxtStartRef.current = null;
        return;
      }
      const rp = ev.renderedPosition ?? { x: 0, y: 0 };
      cxtStartRef.current = { x: rp.x, y: rp.y, moved: false };
    });

    cy.on('cxtdrag', (ev) => {
      const start = cxtStartRef.current;
      if (!start) return;
      const rp = ev.renderedPosition ?? { x: 0, y: 0 };
      if (!start.moved && Math.hypot(rp.x - start.x, rp.y - start.y) < 5) return;
      start.moved = true;
      suppressMenuRef.current = true;
      const box = {
        x1: Math.min(start.x, rp.x),
        y1: Math.min(start.y, rp.y),
        x2: Math.max(start.x, rp.x),
        y2: Math.max(start.y, rp.y)
      };
      marqueeBoxRef.current = box;
      setMarquee(box);
    });

    cy.on('cxttapend', () => {
      const start = cxtStartRef.current;
      const box = marqueeBoxRef.current;
      cxtStartRef.current = null;
      marqueeBoxRef.current = null;
      setMarquee(null);
      if (!start?.moved || !box) return;

      const p1 = renderedToModel(cy, box.x1, box.y1);
      const p2 = renderedToModel(cy, box.x2, box.y2);
      const ids: string[] = [];
      cy.nodes('.location').forEach((n) => {
        const bb = n.boundingBox();
        if (bb.x1 < p2.x && bb.x2 > p1.x && bb.y1 < p2.y && bb.y2 > p1.y) ids.push(n.id());
      });

      cy.batch(() => {
        cy.elements().unselect();
        ids.forEach((id) => cy.getElementById(id).select());
      });
      useGraphStore.getState().setMultiSelect(ids);
    });

    /* --------------------------------------------------- context menus */
    const menuPoint = (ev: any) => {
      const oe = ev.originalEvent as MouseEvent | undefined;
      const rect = containerRef.current!.getBoundingClientRect();
      return {
        x: oe?.clientX ?? rect.left,
        y: oe?.clientY ?? rect.top,
        graphX: ev.position?.x ?? 0,
        graphY: ev.position?.y ?? 0
      };
    };

    cy.on('cxttap', (ev) => {
      if (ev.target !== cy || suppressMenuRef.current) return;
      useGraphStore.getState().openContextMenu(menuPoint(ev));
    });
    cy.on('cxttap', 'node.location', (ev) => {
      if (suppressMenuRef.current) return;
      useGraphStore.getState().openContextMenu({ ...menuPoint(ev), locationId: ev.target.id() });
    });
    cy.on('cxttap', 'node.group', (ev) => {
      if (suppressMenuRef.current) return;
      useGraphStore
        .getState()
        .openContextMenu({ ...menuPoint(ev), groupId: ev.target.data('groupId') });
    });
    cy.on('cxttap', 'node.portal, edge', (ev) => {
      if (suppressMenuRef.current) return;
      const store = useGraphStore.getState();
      store.selectConnection(ev.target.data('connectionId') ?? ev.target.id());
      store.openContextMenu(menuPoint(ev));
    });

    return () => {
      ro.disconnect();
      cy.off('viewport', onViewport);
      if (scaleFrame) cancelAnimationFrame(scaleFrame);
      if (scaleTimer) clearTimeout(scaleTimer);
      setCyReady(false);
      cyHolder.cy = null;
      cyRef.current = null;
      cy.destroy();
    };
  }, []);

  /** Fit against base sizes, then re-apply the zoom compensation. */
  const fitAndRescale = (cy: Core, padding: number) => {
    applyViewScale(cy, 1, settingsRef.current);
    cy.fit(undefined, padding);
    factorRef.current = viewScaleFactor(cy.zoom(), settingsRef.current);
    applyViewScale(cy, factorRef.current, settingsRef.current);
  };

  /* ------------------------------------------------- settings -> canvas */
  useEffect(() => {
    settingsRef.current = settings;
    const cy = cyRef.current;
    if (!cy) return;
    setWheelSensitivity(cy, settings.scrollSensitivity);
    factorRef.current = viewScaleFactor(cy.zoom(), settings);
    applyViewScale(cy, factorRef.current, settings);
    refreshRendering(cy);
  }, [settings]);

  /* ---------------------------------------------- reconcile the elements */
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const fullReset = lastMapRef.current !== mapId;
    lastMapRef.current = mapId;

    const extent = cy.extent();
    const centre = {
      x: Number.isFinite(extent.x1) ? (extent.x1 + extent.x2) / 2 : 0,
      y: Number.isFinite(extent.y1) ? (extent.y1 + extent.y2) / 2 : 0
    };

    const structural = syncGraph(cy, elements, fullReset, centre);
    /* new/changed elements need their zoom-compensated sizes */
    applyViewScale(cy, factorRef.current, settingsRef.current);
    applyHighlight(cy, selection, multiSelect, labelMembers, routePlan, waypoints);
    if (structural) refreshRendering(cy);

    if (fullReset) {
      requestAnimationFrame(() => {
        if (cyRef.current !== cy) return;
        cy.resize();
        if (cy.nodes().length) fitAndRescale(cy, 60);
        refreshRendering(cy);
      });
    }
  }, [elements, selection, multiSelect, labelMembers, routePlan, waypoints, mapId]);

  /* ------------------------------------------------------ run the layout */
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || cy.nodes().length === 0) return;
    let cancelled = false;

    const metrics = computeMetrics(
      cy.edges().map((e) => (e.data('labelWidth') as number) ?? 0),
      cy.nodes().length
    );

    /* stub boxes are persisted too, so a layout keeps them where it put them */
    const snapshot = () => {
      const positions = cy
        .nodes('.location')
        .map((n) => ({ id: n.id(), x: n.position().x, y: n.position().y }));
      const portalOffsets: PortalOffset[] = [];
      cy.nodes('.portal').forEach((p) => {
        const anchor = cy.getElementById(p.data('anchorId'));
        const parsed = parsePortalId(p.id());
        if (anchor.empty() || !parsed) return;
        portalOffsets.push({
          connectionId: parsed.connectionId,
          side: parsed.side,
          dx: p.position().x - anchor.position().x,
          dy: p.position().y - anchor.position().y
        });
      });
      return { positions, portalOffsets };
    };

    if (layout === 'preset') {
      fitAndRescale(cy, 60);
      refreshRendering(cy);
      return;
    }

    /* ------------------------------------------- coordinate grid layouts */
    if (isCoordinateLayout(layout)) {
      const plane = COORDINATE_LAYOUTS[layout];
      const state = useGraphStore.getState();
      const result = computeCoordinateLayout(cy, plane, {
        locations: state.locations,
        connections: state.connections
      });
      if (!result.positions.size) return;

      cy.batch(() => {
        result.positions.forEach((p, id) => {
          const n = cy.getElementById(id);
          if (n.nonempty()) n.position(p);
        });
      });
      rebaseStubOffsets(cy);
      fitAndRescale(cy, 70);
      refreshRendering(cy);

      const snap = snapshot();
      void useGraphStore.getState().persistLayoutPositions(snap.positions, snap.portalOffsets);
      useGraphStore
        .getState()
        .setStatus(
          [
            `${plane.toUpperCase()} Grid`,
            `${result.unit}px Per Coordinate`,
            `${result.placedByCoords} By Coordinates`,
            result.placedByNeighbours ? `${result.placedByNeighbours} By Connections` : '',
            result.seeded ? `${result.seeded} Unconnected` : ''
          ]
            .filter(Boolean)
            .join(' · ')
        );
      return;
    }

    const hasGroups = cy.nodes('.group').nonempty();

    if (!hasGroups) {
      const run = cy.layout(layoutOptions(layout, metrics));
      run.one('layoutstop', () => {
        if (cancelled) return;
        rebaseStubOffsets(cy);
        refreshRendering(cy);
        const snap = snapshot();
        void useGraphStore.getState().persistLayoutPositions(snap.positions, snap.portalOffsets);
      });
      run.run();
      return () => {
        cancelled = true;
        run.stop();
      };
    }

    (async () => {
      const positions = await computeGroupedLayout(cy, layout, metrics);
      if (cancelled || !positions.size) return;
      cy.batch(() => {
        positions.forEach((p, id) => {
          const n = cy.getElementById(id);
          if (n.nonempty() && !n.hasClass('group')) n.position(p);
        });
      });
      fitAndRescale(cy, 70);
      rebaseStubOffsets(cy);
      refreshRendering(cy);
      const snap = snapshot();
      void useGraphStore.getState().persistLayoutPositions(snap.positions, snap.portalOffsets);
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutNonce, mapId]);

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
        data: { id: GHOST_NODE, w: 6, h: 6 },
        position: { x: p.x + 60, y: p.y + 60 },
        selectable: false,
        grabbable: false,
        classes: 'ghost'
      },
      {
        group: 'edges',
        data: { id: GHOST_EDGE, source: pendingSource, target: GHOST_NODE, lineWidth: 3 },
        selectable: false,
        classes: 'ghost-edge'
      }
    ]);
    applyViewScale(cy, factorRef.current, settingsRef.current);

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

  /* ------------------------- draggable endpoints for the selected edge */
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

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

    const srcEdge = cy.getElementById(conn.ephemeral ? `${conn.id}::out-edge` : conn.id);
    const tgtEdge = cy.getElementById(conn.ephemeral ? `${conn.id}::in-edge` : conn.id);
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
    cy.add([
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
    applyViewScale(cy, factorRef.current, settingsRef.current);

    /* the cursor is a far better drop probe than the handle's centre */
    const resolveDrop = (handle: any): NodeSingular | null => {
      const probes = [pointer, handle.position()].filter(Boolean) as Array<{ x: number; y: number }>;
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
      const handle = ev.target;
      const end = handle.data('end') as 'source' | 'target';
      const anchorId = end === 'source' ? conn.targetId : conn.sourceId;
      cy.elements(`[connectionId = "${conn.id}"]`).addClass('reconnecting');
      cy.add({
        group: 'edges',
        data: {
          id: RECONNECT_EDGE,
          lineWidth: 3,
          source: end === 'source' ? handle.id() : anchorId,
          target: end === 'source' ? anchorId : handle.id()
        },
        classes: 'reconnect-edge',
        selectable: false
      });
      applyViewScale(cy, factorRef.current, settingsRef.current);
    };

    const onDrag = (ev: any) => {
      pointer = ev.position ?? pointer;
      cy.nodes('.drop-target').removeClass('drop-target');
      const hit = resolveDrop(ev.target);
      if (hit) hit.addClass('drop-target');
    };

    const onFree = (ev: any) => {
      if (!dragging) return;
      const handle = ev.target;
      const end = handle.data('end') as 'source' | 'target';
      const hit = resolveDrop(handle);

      cy.getElementById(RECONNECT_EDGE).remove();
      cy.elements(`[connectionId = "${conn.id}"]`).removeClass('reconnecting');
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
        .updateConnection(
          conn.id,
          end === 'source' ? { sourceId: hit.id() } : { targetId: hit.id() }
        );
    };

    const onPosition = (ev: any) => {
      if (ev.target.hasClass('handle')) return;
      place();
    };

    cy.on('mousemove', onPointer);
    cy.on('grab', 'node.handle', onGrab);
    cy.on('drag', 'node.handle', onDrag);
    cy.on('free', 'node.handle', onFree);
    cy.on('position', 'node', onPosition);

    return () => {
      cy.off('mousemove', onPointer);
      cy.off('grab', 'node.handle', onGrab);
      cy.off('drag', 'node.handle', onDrag);
      cy.off('free', 'node.handle', onFree);
      cy.off('position', 'node', onPosition);
      cleanup();
    };
  }, [selection, connections]);

  /* keep Cytoscape's native selection in step with the store */
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    if (multiSelect.length > 1) return;
    cy.batch(() => {
      cy.elements().unselect();
      if (selection?.type === 'location') cy.getElementById(selection.id).select();
    });
  }, [selection, multiSelect]);

  /* ---------------------------------------------------------- menu items */
  const menuItems: MenuEntry[] = useMemo(() => {
    if (!contextMenu) return [];
    const store = useGraphStore.getState();
    const groupList = Object.values(groups);
    const tree = buildGroupTree(groupList);

    if (contextMenu.groupId) {
      const id = contextMenu.groupId;
      const name = groups[id]?.name || 'Unnamed Grouping';
      const forbidden = descendantGroupIds(groupList, id);
      const moveEntries = groupMenuEntries(
        tree,
        (parentId) => void store.setGroupParent(id, parentId),
        forbidden,
        groups[id]?.parentId ?? null
      );

      return [
        { kind: 'heading', label: name },
        {
          label: `+ Create Room Inside "${name}"`,
          onSelect: () => void store.createLocationAt(contextMenu.graphX, contextMenu.graphY, id)
        },
        { label: 'Inspect Grouping', onSelect: () => store.selectGroup(id) },
        {
          kind: 'submenu',
          label: 'Move Grouping Into',
          items: [
            {
              label: 'Top Level (No Parent)',
              onSelect: () => void store.setGroupParent(id, null),
              active: !groups[id]?.parentId
            },
            ...(moveEntries.length ? [{ kind: 'heading' as const, label: 'Groupings' }, ...moveEntries] : [])
          ]
        },
        { label: 'Re-Layout Graph', onSelect: () => store.runLayout() },
        { label: 'Remove All Rooms From Grouping', onSelect: () => void store.ungroupAll(id) },
        {
          label: 'Delete Grouping (Keep Contents)',
          danger: true,
          onSelect: () => void store.deleteGroup(id)
        }
      ];
    }

    if (contextMenu.locationId) {
      const id = contextMenu.locationId;
      const loc = locations[id];
      const selected = multiSelect.includes(id) ? multiSelect : [id];
      const assign = (groupId: string | null) =>
        selected.length > 1
          ? void store.bulkUpdateLocations(selected, { groupId })
          : void store.setLocationGroup(id, groupId);

      const groupEntries = groupMenuEntries(tree, assign, undefined, loc?.groupId ?? null);

      return [
        { label: '+ Create Connection', onSelect: () => store.startConnectionFrom(id) },
        {
          label:
            selected.length > 1
              ? `+ Create Grouping From ${selected.length} Rooms`
              : '+ Create Grouping From This Room',
          onSelect: () => void store.createGroupFrom(selected)
        },
        { label: 'Inspect Location', onSelect: () => store.selectLocation(id) },
        {
          label: `+ Add To Trip (Stop ${store.trip.waypoints.length + 1})`,
          onSelect: () => store.addWaypoint(id)
        },
        {
          label: loc?.visited ? 'Mark As Not Visited' : 'Mark As Visited',
          onSelect: () => void store.toggleVisited(id)
        },
        {
          kind: 'submenu',
          label: selected.length > 1 ? `Move ${selected.length} Rooms Into` : 'Move Into Grouping',
          items: [
            { label: 'No Grouping', onSelect: () => assign(null), active: !loc?.groupId },
            ...(groupEntries.length
              ? [{ kind: 'heading' as const, label: 'Groupings' }, ...groupEntries]
              : [])
          ]
        },
        {
          label: selected.length > 1 ? `Delete ${selected.length} Locations` : 'Delete Location',
          danger: true,
          onSelect: () => {
            if (confirm(`Delete ${selected.length} location(s) and their connections?`)) {
              void store.deleteLocations(selected);
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
  }, [contextMenu, locations, groups, multiSelect]);

  const closeMenu = useGraphStore((s) => s.closeContextMenu);

  return (
    <div className={`graph-canvas mode-${mode}`} onContextMenu={(e) => e.preventDefault()}>
      <div ref={containerRef} className="cy-host" />
      {cyReady && <GraphScrollbars />}

      {marquee && (
        <div
          className="marquee"
          style={{
            left: marquee.x1,
            top: marquee.y1,
            width: marquee.x2 - marquee.x1,
            height: marquee.y2 - marquee.y1
          }}
        />
      )}

      {mode !== 'select' && (
        <div className="canvas-hint">
          {mode === 'add-location'
            ? 'Click Anywhere To Place A New Location (Esc To Cancel)'
            : pendingSource
              ? 'Drag To The Destination And Click It (Esc To Cancel)'
              : 'Click The Source Location (Esc To Cancel)'}
        </div>
      )}

      {multiSelect.length > 1 && (
        <div className="canvas-hint subtle">
          {multiSelect.length} Rooms Selected — Drag Any Of Them To Move Them Together
        </div>
      )}

      {contextMenu && (
        <MenuPanel x={contextMenu.x} y={contextMenu.y} items={menuItems} onClose={closeMenu} />
      )}
    </div>
  );
}
