import cytoscape, { Core, ElementDefinition, NodeSingular } from 'cytoscape';
import elk from 'cytoscape-elk';
import fcose from 'cytoscape-fcose';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cyHolder, fitGraph } from '../graph/cyHolder';
import { buildElements, groupNodeId, isInternalId, parsePortalId, portalEdgeId } from '../graph/elements';
import { computeCoordinateLayout } from '../graph/coordinateLayout';
import { computeGroupedLayout } from '../graph/groupLayout';
import { applyGroupLayers, applyRoomLayers, computeGroupLayers } from '../graph/layering';
import { descendantGroupIds, buildGroupTree } from '../graph/groups';
import { applyDragModes } from '../graph/dragModes';
import { COORDINATE_LAYOUTS, computeMetrics, isCoordinateLayout, layoutOptions } from '../graph/layouts';
import type { RoutePlan } from '../graph/pathfinding';
import { graphStyle } from '../graph/style';
import {
  EMPTY_BUDGET,
  type GeometryBudget,
  MAX_COMPENSATED_ELEMENTS,
  applyViewScale,
  baseSize,
  compensationInterval,
  invalidateViewScale,
  renderRatios,
  viewScaleFactor
} from '../graph/viewScale';
import { bindWheelZoom } from '../graph/wheelZoom';
import { DEFAULT_MIN_ZOOM, MAX_ZOOM, fitToContent, refreshMinZoom } from '../graph/zoomBounds';
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

/** A layout that never reports back must not leave the canvas locked to base scale. */
const LAYOUT_WATCHDOG_MS = 20_000;

let extensionsRegistered = false;
function registerExtensions() {
  if (extensionsRegistered) return;
  cytoscape.use(fcose);
  cytoscape.use(elk);
  extensionsRegistered = true;
}

function refreshRendering(cy: Core) {
  cy.forceRender();
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

/**
 * Data the *runtime* owns — the stacking pass writes these after every
 * arrangement — so a reconcile must not reset them (and must not see them as a
 * change, or nothing would ever be skipped). New elements still get the
 * neutral defaults from their definition.
 */
const RUNTIME_DATA = new Set(['zLayer', 'groupFillOpacity', 'groupBorderOpacity']);

/**
 * Classes `buildElements` owns. Everything else (highlight, route, `pan-through`)
 * is applied at runtime and now survives a reconcile, which is what makes the
 * highlight/layering/drag passes cheap no-ops when nothing has changed.
 */
const BASE_CLASSES = [
  'group', 'location', 'visited', 'unvisited', 'has-notes', 'connection',
  'portal', 'portal-out', 'portal-in', 'stub', 'stub-out', 'stub-in'
];

const skipKey = (k: string) => IMMUTABLE.has(k) || RUNTIME_DATA.has(k);

function mutableData(data: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (!skipKey(k)) out[k] = v;
  return out;
}

/** Element data is all primitives, so identity is the right comparison. */
function sameData(current: Record<string, unknown>, next: Record<string, unknown>) {
  for (const k in next) {
    if (skipKey(k)) continue;
    if (current[k] !== next[k]) return false;
  }
  return true;
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

      /* a write that changes nothing still restyles the element: on a big map
         that is the difference between editing one room and restyling the lot */
      const next = el.data as Record<string, unknown>;
      if (!sameData(existing.data(), next)) {
        existing.data(mutableData(next));
        /* its `…View` twins are derived from `w`/`h`/`lineWidth` — re-derive them */
        invalidateViewScale(existing);
      }

      const wanted = new Set(
        (typeof el.classes === 'string' ? el.classes : '').split(' ').filter(Boolean)
      );
      for (const cls of BASE_CLASSES) {
        const want = wanted.has(cls);
        if (existing.hasClass(cls) === want) continue;
        if (want) existing.addClass(cls);
        else existing.removeClass(cls);
      }

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

const HIGHLIGHT_CLASSES =
  'hl-primary hl-neighbor faded route-node route-edge route-start route-stop route-end';
const HIGHLIGHT_SELECTOR =
  '.hl-primary, .hl-neighbor, .faded, .route-node, .route-edge, .route-start, .route-stop, .route-end';

function applyHighlight(
  cy: Core,
  selection: Selection | null,
  multi: string[],
  labelMembers: string[] = [],
  route: RoutePlan | null = null,
  waypoints: string[] = []
) {
  cy.batch(() => {
    /* only the elements that actually carry one — clearing the whole graph cost
       a style write per element even with nothing selected */
    cy.elements(HIGHLIGHT_SELECTOR).removeClass(HIGHLIGHT_CLASSES);

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
  /** Sits above the Cytoscape container, so it can intercept the wheel first. */
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const lastMapRef = useRef<string | null>(null);
  const [cyReady, setCyReady] = useState(false);
  const factorRef = useRef(1);
  /** Elements deferred by the last viewport-limited pass. */
  const staleRef = useRef(0);
  /** The render ratio last applied — how the viewport handler detects a real change. */
  const ratiosRef = useRef({ box: 1, text: 1 });
  /** Drives the global render ratio; shapes and scalars are already in `w`/`h`. */
  const budgetRef = useRef<GeometryBudget>(EMPTY_BUDGET);
  /** Kept in step with `elements`, so rate-limiting never has to walk the graph. */
  const elementCountRef = useRef(0);
  const compensationWarnedRef = useRef(false);
  /**
   * Held by the layout currently being solved, so every effect agrees on base
   * geometry. A token rather than a boolean: a cancelled layout can still emit
   * `layoutstop` long after its successor has taken the lock, and releasing
   * someone else's lock leaves the canvas mis-scaled.
   */
  const layoutScaleLock = useRef<object | null>(null);
  const settingsRef = useRef(useGraphStore.getState().settings);
  /**
   * Which layout produced the arrangement on screen. This is *not* `layout`:
   * persisting a layout's result flips the picker to "Saved Positions", but a
   * coordinate arrangement must keep its coordinate-based grouping stack.
   */
  const layeringSourceRef = useRef(useGraphStore.getState().layout);

  /**
   * The compensation factor to use right now. Off, or past the element ceiling,
   * it is simply 1 — and then the viewport handler does no work at all. Reads
   * refs only, so it stays stable across renders without being memoised.
   */
  const compensationFor = (cy: Core) => {
    const settings = settingsRef.current;
    if (!settings.constantSize) return 1;
    if (elementCountRef.current > MAX_COMPENSATED_ELEMENTS) {
      if (!compensationWarnedRef.current) {
        compensationWarnedRef.current = true;
        useGraphStore
          .getState()
          .setStatus('Zoom-Independent Sizing Paused — Too Many Elements On This Map');
      }
      return 1;
    }
    return viewScaleFactor(cy.zoom(), settings);
  };

  /** Apply and remember what was applied, so the viewport handler can short-circuit. */
  const rescale = (
    cy: Core,
    f: number,
    opts?: { unclamped?: boolean; viewportOnly?: boolean }
  ) => {
    ratiosRef.current = opts?.unclamped
      ? { box: 1, text: 1 }
      : renderRatios(cy.zoom(), f, budgetRef.current);
    staleRef.current = applyViewScale(cy, f, settingsRef.current, budgetRef.current, opts);
  };

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
        baseScale: settings.baseScale,
        positionOverrides: pendingPositions,
        portalOffsetOverrides: pendingPortalOffsets,
        ...labelNames
      }),
    [
      locations,
      connections,
      groups,
      labelMode,
      settings.baseScale,
      pendingPositions,
      pendingPortalOffsets,
      labelNames
    ]
  );

  /** Drives the global render ratio; shapes and scalars are already in `w`/`h`. */
  const budget = useMemo<GeometryBudget>(() => {
    let maxBox = 0;
    let maxLabel = 0;
    for (const el of elements) {
      const d = el.data as Record<string, unknown>;
      if (typeof d.w === 'number' && typeof d.h === 'number') {
        maxBox = Math.max(maxBox, d.w, d.h);
      }
      if (typeof d.labelWidth === 'number') maxLabel = Math.max(maxLabel, d.labelWidth);
    }
    return { maxBox, maxLabel };
  }, [elements]);

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
    if (!containerRef.current || !wrapperRef.current) return;
    registerExtensions();

    const cy = cytoscape({
      container: containerRef.current,
      style: graphStyle,
      elements: [],
      hideEdgesOnViewport: false,
      textureOnViewport: false,
      motionBlur: false,
      /* the floor tracks the map's size from here on — see graph/zoomBounds */
      minZoom: DEFAULT_MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      selectionType: 'single',
      boxSelectionEnabled: false
    });

    cyRef.current = cy;
    cyHolder.cy = cy;
    cyHolder.fit = (padding = 60) => fitAndRescale(cy, padding);
    setCyReady(true);

    /* the app owns wheel zooming — see graph/wheelZoom for why Cytoscape's is
       bypassed. Sensitivity is read per event, so Settings applies instantly. */
    const unbindWheel = bindWheelZoom(wrapperRef.current, cy, {
      sensitivity: () => settingsRef.current.scrollSensitivity,
      blocked: () => !!cxtStartRef.current?.moved || cy.nodes(':grabbed').nonempty()
    });

    /* keep boxes/labels a constant size on screen while zooming */
    factorRef.current = compensationFor(cy);
    rescale(cy, factorRef.current);

    let scaleFrame = 0;
    let scaleTimer: ReturnType<typeof setTimeout> | null = null;
    let lastScaleAt = 0;

    const refreshScale = () => {
      scaleFrame = 0;
      const f = compensationFor(cy);
      const moved = Math.abs(f - factorRef.current) / Math.max(factorRef.current, 0.0001) >= 0.03;
      if (moved) factorRef.current = f;
      if (layoutScaleLock.current) return; // a running layout owns the geometry

      const next = renderRatios(cy.zoom(), factorRef.current, budgetRef.current);
      const clamped = next.box !== ratiosRef.current.box || next.text !== ratiosRef.current.text;
      if (!moved && !clamped && staleRef.current === 0) return;

      lastScaleAt = performance.now();
      rescale(cy, factorRef.current, { viewportOnly: true });
    };

    /* one pass restyles every element, so its rate has to follow the graph size */
    const scheduleScale = () => {
      if (scaleTimer || scaleFrame) return;
      const wait = Math.max(
        0,
        compensationInterval(elementCountRef.current) - (performance.now() - lastScaleAt)
      );
      if (wait === 0) {
        scaleFrame = requestAnimationFrame(refreshScale);
        return;
      }
      scaleTimer = setTimeout(() => {
        scaleTimer = null;
        scaleFrame = requestAnimationFrame(refreshScale);
      }, wait);
    };

    /* nothing depends on the zoom while the ratio is 1, so an unclamped pan or
       zoom with compensation off costs nothing at all */
    const viewportDirty = () => {
      if (staleRef.current > 0 || settingsRef.current.constantSize) return true;
      const next = renderRatios(cy.zoom(), 1, budgetRef.current);
      return next.box !== ratiosRef.current.box || next.text !== ratiosRef.current.text;
    };
    const onViewport = () => {
      if (viewportDirty()) scheduleScale();
    };
    cy.on('viewport', onViewport);

    let fittedOnce = false;
    const ro = new ResizeObserver(() => {
      const el = containerRef.current;
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
      cy.resize();
      refreshMinZoom(cy, settingsRef.current);
      if (!fittedOnce && cy.nodes().length) {
        fittedOnce = true;
        fitAndRescale(cy, 60);
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
      restack(cy);
    });

    /* ------------------------------------- right-drag marquee selection */
    cy.on('cxttapstart', (ev) => {
      suppressMenuRef.current = false;
      /* a grouping box must not block a marquee — one never catches groupings */
      if (ev.target !== cy && !ev.target.hasClass('group')) {
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
      unbindWheel();
      cy.off('viewport', onViewport);
      if (scaleFrame) cancelAnimationFrame(scaleFrame);
      if (scaleTimer) clearTimeout(scaleTimer);
      setCyReady(false);
      cyHolder.fit = null;
      cyHolder.cy = null;
      cyRef.current = null;
      cy.destroy();
    };
  }, []);

  /** Frame the whole map, then re-apply the zoom compensation. */
  const fitAndRescale = (cy: Core, padding: number) => {
    fitToContent(cy, settingsRef.current, padding);
    factorRef.current = compensationFor(cy);
    rescale(cy, currentScale(), { viewportOnly: true });
  };

  /** The scale every other effect should write: 1 while a layout is running. */
  const currentScale = () => (layoutScaleLock.current ? 1 : factorRef.current);

  /**
   * Recompute the grouping stack and push it onto the graph, synchronously —
   * called right after positions are written so there is no round-trip through
   * the server before the stack (and the sidebar's "Layer N/M" readout) catch up.
   */
  const restack = (cy: Core) => {
    const { groups, locations } = useGraphStore.getState();
    const plane = isCoordinateLayout(layeringSourceRef.current)
      ? COORDINATE_LAYOUTS[layeringSourceRef.current]
      : null;
    const layers = computeGroupLayers(cy, Object.values(groups), Object.values(locations), plane);
    applyGroupLayers(cy, layers);
    applyRoomLayers(cy, locations, plane);
    useGraphStore.getState().setGroupLayers(layers);
  };

  /* ------------------------------------------------- settings -> canvas */
  useEffect(() => {
    settingsRef.current = settings;
    const cy = cyRef.current;
    if (!cy) return;
    factorRef.current = compensationFor(cy);
    rescale(cy, currentScale(), { viewportOnly: true });
    refreshRendering(cy);
  }, [settings]);

  /* --------------------------------------------------- drag vs pan */
  const pickedForDrag = useMemo(() => {
    const ids = new Set<string>(multiSelect);
    if (selection?.type === 'location') ids.add(selection.id);
    if (selection?.type === 'group') ids.add(groupNodeId(selection.id));
    return ids;
  }, [selection, multiSelect]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    applyDragModes(cy, {
      groups: settings.groupDrag,
      locations: settings.locationDrag,
      picked: pickedForDrag
    });
    /* `elements` so freshly added rooms and groupings are configured too */
  }, [settings.groupDrag, settings.locationDrag, pickedForDrag, elements]);

  /* ---------------------------------------------- reconcile the elements */
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const fullReset = lastMapRef.current !== mapId;
    lastMapRef.current = mapId;
    elementCountRef.current = elements.length;
    budgetRef.current = budget;
    if (fullReset) compensationWarnedRef.current = false;

    const extent = cy.extent();
    const centre = {
      x: Number.isFinite(extent.x1) ? (extent.x1 + extent.x2) / 2 : 0,
      y: Number.isFinite(extent.y1) ? (extent.y1 + extent.y2) / 2 : 0
    };

    const structural = syncGraph(cy, elements, fullReset, centre);
    /* groupings are drawn bottom-most; their order follows the rooms */
    restack(cy);
    /* new/changed elements need their zoom-compensated sizes */
    rescale(cy, currentScale(), { viewportOnly: true });
    /* …and a bigger (or smaller) map can be pulled back further (or less) */
    refreshMinZoom(cy, settingsRef.current);
    /* a precise, once-per-reconcile signal — unlike `style`, which fires per element */
    cy.emit('mapgraphgeometry');
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
  }, [elements, budget, selection, multiSelect, labelMembers, routePlan, waypoints, mapId]);

  /* ------------------------------------------------------ run the layout */
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || cy.nodes().length === 0) return;
    let cancelled = false;
    layeringSourceRef.current = layout;

    const metrics = computeMetrics(
      cy.edges().map((e) => (e.data('labelWidth') as number) ?? 0),
      /* base boxes, so every location's size scalar reaches the engines */
      cy.nodes('.location, .portal').map((n) => {
        const b = baseSize(n);
        return Math.max(b.w, b.h);
      }),
      /* so the "oversized room" threshold is relative to the current base size */
      settingsRef.current.baseScale
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
      restack(cy);
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
      restack(cy); // off-plane coordinate order
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
      /* Solve against base geometry: the arrangement must depend on the rooms'
         own sizes, never on the current zoom compensation (which would other-
         wise inflate every box and make each re-layout drift larger). */
      const token = {};
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      const release = () => {
        if (watchdog) {
          clearTimeout(watchdog);
          watchdog = null;
        }
        /* only the run that took the lock may hand it back: a cancelled layout
           can still emit `layoutstop` after its successor has taken it */
        if (layoutScaleLock.current !== token) return;
        layoutScaleLock.current = null;
        rescale(cy, factorRef.current, { viewportOnly: true });
      };
      layoutScaleLock.current = token;
      /* the engines read `n.width()`: no compensation, and no rendered ceilings */
      rescale(cy, 1, { unclamped: true });
      /* …and a layout that never reports back must not freeze the compensation,
         which looks exactly like the wheel suddenly got more sensitive */
      watchdog = setTimeout(release, LAYOUT_WATCHDOG_MS);

      const run = cy.layout(layoutOptions(layout, metrics));
      run.one('layoutstop', () => {
        release();
        if (cancelled) return;
        rebaseStubOffsets(cy);
        restack(cy); // areas are final now that every room has landed
        fitAndRescale(cy, 60);
        refreshRendering(cy);
        const snap = snapshot();
        void useGraphStore.getState().persistLayoutPositions(snap.positions, snap.portalOffsets);
      });
      run.run();
      return () => {
        cancelled = true;
        run.stop();
        release();
      };
    }

    (async () => {
      const positions = await computeGroupedLayout(cy, layout, settingsRef.current.baseScale);
      if (cancelled || !positions.size) return;
      cy.batch(() => {
        positions.forEach((p, id) => {
          const n = cy.getElementById(id);
          if (n.nonempty() && !n.hasClass('group')) n.position(p);
        });
      });
      restack(cy); // areas are final now that every room has landed
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
    rescale(cy, currentScale());

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
    rescale(cy, currentScale());

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
      rescale(cy, currentScale());
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
    /* makes "Draggable When Selected" comfortable: put the thing down from here */
    const deselect: MenuEntry[] =
      selection || multiSelect.length
        ? [{ label: 'Deselect', onSelect: () => store.select(null) }]
        : [];

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
        {
          label: `+ Create Room Outside "${name}"`,
          onSelect: () => void store.createLocationAt(contextMenu.graphX, contextMenu.graphY, null)
        },
        { label: 'Inspect Grouping', onSelect: () => store.selectGroup(id) },
        ...deselect,
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
        ...deselect,
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
      ...deselect,
      { label: 'Fit To Screen', onSelect: () => fitGraph() }
    ];
  }, [contextMenu, locations, groups, multiSelect, selection]);

  const closeMenu = useGraphStore((s) => s.closeContextMenu);

  return (
    <div
      ref={wrapperRef}
      className={`graph-canvas mode-${mode}`}
      onContextMenu={(e) => e.preventDefault()}
    >
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
