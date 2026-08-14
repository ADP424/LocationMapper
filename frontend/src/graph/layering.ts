import type { Core, NodeSingular } from 'cytoscape';
import type { Group, Location } from '../types';
import { coordValue, offPlaneAxis, type CoordinatePlane } from './coordinateLayout';
import { groupNodeId } from './elements';
import { buildGroupTree, type GroupTreeNode } from './groups';
import { DEFAULT_GROUP_PADDING, titleScaleForArea } from './model';
import { layoutSpan } from './viewScale';

export interface GroupLayer {
  /** 1 = drawn first, i.e. at the bottom of the stack. */
  order: number;
  total: number;
  /** Why it sits there ("Z 2"); empty when the order came from box size. */
  note: string;
}

/* The higher a grouping sits, the more solid it reads — the conventional way to
   see through a stack of translucent sheets and still know which is on top.
   Rooms get no ramp: they are opaque, so the occlusion order is the cue. */
const FILL_OPACITY = [0.08, 0.4] as const;
const BORDER_OPACITY = [0.35, 1] as const;

const lerp = (from: number, to: number, t: number) => from + (to - from) * t;
const pretty = (n: number) => String(Math.round(n * 100) / 100);

/** A write that changes nothing still restyles the element. */
const setData = (node: NodeSingular, key: string, value: number) => {
  if (node.data(key) !== value) node.data(key, value);
};

/**
 * A grouping's footprint from *base* geometry — position plus each member's
 * `layoutSpan` (box or name plate, whichever is bigger), never drawn geometry
 * — so it is correct even for members the ViewScaler has left stale
 * off-screen, and costs one pass over each grouping's own members instead of
 * a `boundingBox()` compound-bounds recalc over its whole subtree.
 *
 * Members come from the membership map, not `children()`: a non-anchor member
 * reaches the grouping's footprint without being its compound child. Ephemeral
 * stubs are never themselves a membership — they still come from the compound
 * tree, riding their anchor room's.
 */
/** The title is sized from the grouping's total footprint, and nothing else. */
function applyTitleScale(g: NodeSingular, area: number) {
  const scale = titleScaleForArea(area);
  setData(g, 'titleScale', scale);
  setData(g, 'titleW', ((g.data('titleW0') as number) || 0) * scale);
  setData(g, 'titleH', ((g.data('titleH0') as number) || 0) * scale);
}

/** Areas for the stacking order, and the box itself (published to `boxW`/
 *  `boxH`) for the skeleton view's title fit. */
function measureGroupAreas(
  cy: Core,
  tree: GroupTreeNode[],
  members: Map<string, string[]>
): Map<string, number> {
  const areas = new Map<string, number>();
  const walk = (node: GroupTreeNode): { x1: number; y1: number; x2: number; y2: number } | null => {
    let box: { x1: number; y1: number; x2: number; y2: number } | null = null;
    const grow = (x1: number, y1: number, x2: number, y2: number) => {
      box = box
        ? { x1: Math.min(box.x1, x1), y1: Math.min(box.y1, y1), x2: Math.max(box.x2, x2), y2: Math.max(box.y2, y2) }
        : { x1, y1, x2, y2 };
    };
    for (const child of node.children) {
      const b = walk(child);
      if (b) grow(b.x1, b.y1, b.x2, b.y2);
    }
    for (const id of members.get(node.group.id) ?? []) {
      const n = cy.getElementById(id);
      if (n.empty()) continue;
      const p = n.position();
      const { w, h } = layoutSpan(n);
      grow(p.x - w / 2, p.y - h / 2, p.x + w / 2, p.y + h / 2);
    }
    cy.getElementById(groupNodeId(node.group.id))
      .children('node.portal')
      .forEach((n) => {
        const p = n.position();
        const { w, h } = layoutSpan(n);
        grow(p.x - w / 2, p.y - h / 2, p.x + w / 2, p.y + h / 2);
      });
    const g = cy.getElementById(groupNodeId(node.group.id));
    /* the grouping's own drawn padding — the footprint the user actually sees */
    const padRaw = g.data('bodyPadding') as number;
    const pad = Number.isFinite(padRaw) && padRaw >= 0 ? padRaw : DEFAULT_GROUP_PADDING;
    if (box) {
      const b = box as { x1: number; y1: number; x2: number; y2: number };
      const out = {
        x1: b.x1 - pad,
        y1: b.y1 - pad,
        x2: b.x2 + pad,
        y2: b.y2 + pad
      };
      const gw = out.x2 - out.x1;
      const gh = out.y2 - out.y1;
      areas.set(node.group.id, gw * gh);
      setData(g, 'boxW', gw);
      setData(g, 'boxH', gh);
      applyTitleScale(g, gw * gh);
      return out;
    }
    areas.set(node.group.id, 0);
    setData(g, 'boxW', 0);
    setData(g, 'boxH', 0);
    applyTitleScale(g, 0);
    return null;
  };
  tree.forEach(walk);
  return areas;
}

/**
 * Decide the stacking order of the groupings.
 *
 *  - coordinate layouts: along the axis the plane does not show, lowest first,
 *    so an X/Y plane stacks its groupings by Z like a pile of floors;
 *  - every other layout: by the area each box ended up covering, biggest first,
 *    so a large box can never hide the small ones sitting in its footprint.
 *
 * The indices come from a pre-order walk, which guarantees a sub-grouping is
 * drawn over its parent no matter what the ordering says, and keeps each
 * subtree contiguous so a grouping and its contents stack as one unit.
 */
export function computeGroupLayers(
  cy: Core,
  groups: Group[],
  locations: Location[],
  plane: CoordinatePlane | null
): Record<string, GroupLayer> {
  const drawn = groups.filter((g) => cy.getElementById(groupNodeId(g.id)).nonempty());
  if (!drawn.length) return {};

  const axis = plane ? offPlaneAxis(plane) : null;

  const roomsOf = new Map<string, Location[]>();
  for (const l of locations) {
    for (const gid of l.groupIds) {
      const list = roomsOf.get(gid);
      if (list) list.push(l);
      else roomsOf.set(gid, [l]);
    }
  }

  /* a compound node's box is its contents plus padding, so this is the real
     footprint the user sees. `boundingBox()` would force a compound bounds
     recalc over the whole subtree, and it reads *drawn* geometry — which,
     under the viewport-culled ViewScaler, is stale or zero for off-screen
     children. The footprint is exactly the union of the member rooms' base
     boxes, which is already known from `data.w/h`. */
  const tree = buildGroupTree(drawn);
  const areaOf = measureGroupAreas(
    cy,
    tree,
    new Map([...roomsOf].map(([gid, rooms]) => [gid, rooms.map((r) => r.id)]))
  );

  /** Mean off-plane coordinate of every room nested inside, or null if none has one. */
  const coordOf = new Map<string, number | null>();
  const measure = (node: GroupTreeNode): { sum: number; count: number } => {
    let sum = 0;
    let count = 0;
    for (const child of node.children) {
      const inner = measure(child);
      sum += inner.sum;
      count += inner.count;
    }
    if (axis) {
      for (const room of roomsOf.get(node.group.id) ?? []) {
        const v = coordValue(room, axis);
        if (v !== null) {
          sum += v;
          count++;
        }
      }
    }
    coordOf.set(node.group.id, count ? sum / count : null);
    return { sum, count };
  };

  tree.forEach(measure);

  /** Bottom of the stack first. */
  const compare = (a: Group, b: Group) => {
    if (axis) {
      const va = coordOf.get(a.id) ?? null;
      const vb = coordOf.get(b.id) ?? null;
      /* nothing to stack by: park it underneath everything that does have a coordinate */
      const ca = va === null ? -Infinity : va;
      const cb = vb === null ? -Infinity : vb;
      if (ca !== cb) return ca - cb;
    }
    const aa = areaOf.get(a.id) ?? 0;
    const ab = areaOf.get(b.id) ?? 0;
    if (aa !== ab) return ab - aa; // the biggest footprint goes underneath
    return (a.name || '').localeCompare(b.name || '') || a.id.localeCompare(b.id);
  };

  const layers: Record<string, GroupLayer> = {};
  let order = 0;
  const walk = (nodes: GroupTreeNode[]) => {
    for (const node of [...nodes].sort((x, y) => compare(x.group, y.group))) {
      const coord = coordOf.get(node.group.id) ?? null;
      layers[node.group.id] = {
        order: ++order,
        total: drawn.length,
        note: axis ? `${axis.toUpperCase()} ${coord === null ? '—' : pretty(coord)}` : ''
      };
      walk(node.children);
    }
  };
  walk(tree);

  return layers;
}

/** Push the grouping order onto the graph: z-index plus a readable opacity ramp. */
export function applyGroupLayers(cy: Core, layers: Record<string, GroupLayer>) {
  cy.batch(() => {
    for (const [id, layer] of Object.entries(layers)) {
      const node = cy.getElementById(groupNodeId(id));
      if (node.empty()) continue;
      /* a lone grouping keeps the neutral mid-ramp look */
      const t = layer.total > 1 ? (layer.order - 1) / (layer.total - 1) : 0.5;
      setData(node, 'zLayer', layer.order);
      setData(node, 'groupFillOpacity', lerp(FILL_OPACITY[0], FILL_OPACITY[1], t));
      setData(node, 'groupBorderOpacity', lerp(BORDER_OPACITY[0], BORDER_OPACITY[1], t));
    }
  });
}

/**
 * Order the rooms by the same rule as the groupings:
 *
 *  - coordinate layouts: by the axis the plane does not show, lowest drawn
 *    first, so a room on Z 0 sits under a room on Z 3 exactly as their
 *    groupings do;
 *  - every other layout: biggest box first, so a large room can never bury a
 *    small one it happens to overlap.
 *
 * Leaf nodes all share one compound-depth band in Cytoscape, so `z-index`
 * orders grouped and ungrouped rooms together — and every room still draws over
 * every grouping box, which lives in the bottom band. Ephemeral stubs adopt
 * their anchor room's layer, since they belong to it.
 */
export function applyRoomLayers(
  cy: Core,
  locations: Record<string, Location>,
  plane: CoordinatePlane | null
) {
  const axis = plane ? offPlaneAxis(plane) : null;
  const rooms = cy.nodes('.location');
  if (rooms.empty()) return;

  const ranked = rooms.map((node) => {
    const room = locations[node.id()];
    const coord = axis && room ? coordValue(room, axis) : null;
    /* the plate is what occludes, so the plate is what decides the draw order */
    const box = layoutSpan(node);
    return {
      id: node.id(),
      node,
      /* no coordinate on this axis: park it underneath the ones that have one */
      coord: coord === null ? -Infinity : coord,
      area: Math.max(0, box.w) * Math.max(0, box.h)
    };
  });

  ranked.sort((a, b) => {
    if (axis && a.coord !== b.coord) return a.coord - b.coord;
    if (a.area !== b.area) return b.area - a.area; // the biggest box is drawn first
    return a.id.localeCompare(b.id); // stable across re-renders
  });

  const layerOf = new Map<string, number>();
  cy.batch(() => {
    ranked.forEach((room, i) => {
      layerOf.set(room.id, i + 1);
      setData(room.node, 'zLayer', i + 1);
    });
    cy.nodes('.portal').forEach((stub) => {
      setData(stub, 'zLayer', layerOf.get(stub.data('anchorId') as string) ?? 0);
    });
  });
}
