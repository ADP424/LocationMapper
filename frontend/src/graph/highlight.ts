import type { Collection, Core, NodeCollection } from 'cytoscape';
import type { RoutePlan } from './pathfinding';
import { groupNodeId } from './elements';
import type { Selection } from '../types';

const CLASSES =
  'hl-primary hl-neighbor route-dim route-node route-edge route-start route-stop route-end';
const SELECTOR =
  '.hl-primary, .hl-neighbor, .route-dim, .route-node, .route-edge, .route-start, .route-stop, .route-end';

/** connectionId -> the edge (or the two stubs and two stub edges) that draw it. */
export type ConnectionIndex = Map<string, Collection>;

/**
 * Built once per reconcile (not per click): every `cy.elements('[connectionId =
 * "…"]')` selector scan the old highlight pass did — several times per click —
 * becomes a `Map.get`.
 */
export function buildConnectionIndex(cy: Core): ConnectionIndex {
  const index: ConnectionIndex = new Map();
  cy.elements('[connectionId]').forEach((el) => {
    const id = el.data('connectionId') as string;
    const hit = index.get(id);
    index.set(id, (hit ?? cy.collection()).union(el as unknown as Collection));
  });
  return index;
}

/**
 * Selection highlights are additive: the picked thing and its neighbourhood
 * are emphasised, and *nothing else changes* — no fading, no hidden names, no
 * dimmed surroundings. Only the trip planner dims, because a planned route is
 * explicitly a view of the route — and even that keeps the rest of the map
 * legible (see `.route-dim` in style.ts, a soft 45% rather than the old 18%).
 */
export function applyHighlight(
  cy: Core,
  index: ConnectionIndex,
  selection: Selection | null,
  multi: string[],
  labelMembers: string[] = [],
  route: RoutePlan | null = null,
  waypoints: string[] = []
) {
  const conn = (id: string) => index.get(id) ?? cy.collection();

  cy.batch(() => {
    cy.elements(SELECTOR).removeClass(CLASSES);

    /* ------------------------------------------------------ planned trip */
    if (route && (route.locationIds.length || route.connectionIds.length)) {
      const wantedNodes = new Set(route.locationIds);
      const nodes = cy.nodes('.location').filter((n) => wantedNodes.has(n.id()));
      let routeEles = cy.collection();
      for (const id of route.connectionIds) routeEles = routeEles.union(conn(id));

      const keep = nodes
        .union(routeEles)
        .union(routeEles.connectedNodes())
        .union(nodes.parents())
        .union(routeEles.nodes().parents());
      cy.elements().difference(keep).addClass('route-dim');

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
        cy.getElementById(selection.id).removeClass('route-dim').addClass('hl-primary');
      } else if (selection?.type === 'connection') {
        conn(selection.id).removeClass('route-dim').addClass('hl-primary');
      }
      return;
    }

    if (multi.length > 1 || !selection) return;

    /* ---------------------------------------------------- label selected */
    if (selection.type === 'location-label' || selection.type === 'connection-label') {
      const members = new Set(labelMembers);
      let primary =
        selection.type === 'location-label'
          ? cy.nodes('.location').filter((n) => members.has(n.id()))
          : cy.collection();
      if (selection.type === 'connection-label') {
        members.forEach((id) => {
          primary = primary.union(conn(id));
        });
      }
      if (primary.empty()) return;
      primary
        .union(primary.connectedEdges())
        .union(primary.connectedEdges().connectedNodes())
        .union(primary.nodes().parents())
        .difference(primary)
        .addClass('hl-neighbor');
      primary.addClass('hl-primary');
      return;
    }

    /* ------------------------------------------- room / connection / group */
    const primary: Collection =
      selection.type === 'location'
        ? (cy.getElementById(selection.id) as unknown as Collection)
        : selection.type === 'connection'
          ? conn(selection.id)
          : (cy.getElementById(groupNodeId(selection.id)) as unknown as Collection);
    if (primary.empty()) return;

    let nbh: Collection =
      selection.type === 'group'
        ? (() => {
            const members = (primary as unknown as NodeCollection).descendants();
            const edges = members.connectedEdges();
            return members.union(edges).union(edges.connectedNodes());
          })()
        : primary.closedNeighborhood();

    /* an ephemeral stub stands for its whole connection */
    nbh.filter('node.portal').forEach((p) => {
      const cid = p.data('connectionId');
      if (cid) nbh = nbh.union(conn(cid));
    });
    nbh = nbh.union(nbh.filter('node.portal').neighborhood());
    nbh = nbh.union(nbh.nodes().parents());

    nbh.addClass('hl-neighbor');
    primary.removeClass('hl-neighbor').addClass('hl-primary');
  });
}
