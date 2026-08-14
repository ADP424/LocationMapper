import type { Core, NodeSingular } from 'cytoscape';
import type { Group, GroupDisplayStyle, Location } from '../types';
import { membersByGroup } from './groups';
import { DEFAULT_GROUP_PADDING, normaliseGroupDisplay } from './model';
import {
  bandRects,
  boundsOf,
  connectingCorridors,
  expandAll,
  formFit,
  inRect,
  rectRing,
  snakeLoop,
  topEdgeOf,
  type Pt,
  type Rect,
  type Ring,
  type SnakeLoop
} from './groupShape';

/** Every grouping's body is now drawn by the overlay — rectangles included —
 *  so overlapping bodies of any style share one z-order. */
export interface GroupBody {
  groupId: string;
  nodeId: string;
  node: NodeSingular;
  style: GroupDisplayStyle;
  /** Stacking order, straight from the layering pass. */
  zLayer: number;
  /** `outline`; empty for a rectangle or a loop whose snake routed. */
  rings: Ring[];
  /** The filled area — hit testing, and the bounds of what gets painted. */
  rects: Rect[];
  /** The region's overall bounds — `boundsOf(rects)`, cached once per body. */
  bounds: Rect;
  loop: SnakeLoop | null;
  /** A grouping that anchors no room (every membership is someone else's
   *  anchor) is a childless compound node; its own position/size come from
   *  this body's bounds instead of Cytoscape's compound geometry. */
  leaf: boolean;
  /** Node-centre → the centre of the body's top-most edge. The title's anchor. */
  titleDx: number;
  titleDy: number;
}

/** The gap between the title's baseline box and the edge it sits on. Matches the
 *  −8·tv margin a rectangle's title has carried since the beginning. */
export const TITLE_GAP = 8;

const boxOf = (n: NodeSingular): Rect => {
  const bb = n.boundingBox({ includeLabels: false, includeOverlays: false });
  return { x1: bb.x1, y1: bb.y1, x2: bb.x2, y2: bb.y2 };
};

const paddingOf = (node: NodeSingular): number => {
  const p = node.data('bodyPadding') as number;
  return Number.isFinite(p) && p >= 0 ? p : DEFAULT_GROUP_PADDING;
};

interface Region {
  rects: Rect[];
  leaves: Rect[];
  bounds: Rect | null;
}

/**
 * The one owner of every grouping's drawn body — rectangles included, now that
 * membership means two bodies can genuinely overlap and a Cytoscape-painted
 * rectangle would always win the stack regardless of `zLayer`.
 *
 *   `get()`  — per frame, for painting and hit testing. Recomputes when a
 *              position changed; writes nothing.
 *   `sync()` — once per geometry reset (graph/geometry step 2b). Publishes what
 *              the stylesheet and the layout need: the title's anchor on the
 *              body's top-most edge, and — for a grouping that anchors no room
 *              — the leaf node's own position and size. Runs before the extent
 *              is rebuilt, so every bound downstream sees the right box.
 */
export class GroupBodyStore {
  private bodies: GroupBody[] = [];
  private dirty = true;

  constructor(
    private cy: Core,
    private groupsOf: () => Record<string, Group>,
    private locationsOf: () => Record<string, Location>
  ) {}

  markDirty() {
    this.dirty = true;
  }

  get(): GroupBody[] {
    if (this.dirty) {
      this.rebuild();
      this.dirty = false;
    }
    return this.bodies;
  }

  sync(): GroupBody[] {
    this.rebuild();
    this.dirty = false;
    this.apply();
    return this.bodies;
  }

  private rebuild() {
    const { cy } = this;
    const groups = this.groupsOf();
    const members = membersByGroup(Object.values(this.locationsOf()));
    this.bodies = [];
    const nodes = cy.nodes('.group');
    if (nodes.empty()) return;

    /* region(g) = ⋃(member ⊕ P) ∪ ⋃(region(sub) ⊕ P) ∪ ⋃(corridor ⊕ P).
       Members come from the membership map, not `children()` — a non-anchor
       member reaches the grouping's body without being its compound child.
       Ephemeral stubs are never themselves a membership: they ride their
       anchor room's, so they still come from the compound tree. */
    const regions = new Map<string, Region>();
    const visit = (g: NodeSingular): Region => {
      const hit = regions.get(g.id());
      if (hit) return hit;

      const pad = paddingOf(g);
      const leaves: Rect[] = [];
      const units: Rect[] = [];
      for (const id of members.get(g.data('groupId') as string) ?? []) {
        const n = cy.getElementById(id);
        if (n.empty()) continue;
        const box = boxOf(n);
        leaves.push(box);
        units.push(box);
      }
      g.children('node.portal').forEach((n) => {
        const box = boxOf(n);
        leaves.push(box);
        units.push(box);
      });
      const own: Rect[] = [...leaves];
      g.children('node.group').forEach((child) => {
        const sub = visit(child);
        own.push(...sub.rects);
        leaves.push(...sub.leaves);
        if (sub.bounds) units.push(sub.bounds);
      });
      own.push(...connectingCorridors(units, pad));

      const rects = expandAll(own, pad);
      const region: Region = { rects, leaves, bounds: boundsOf(rects) };
      regions.set(g.id(), region);
      return region;
    };

    nodes.forEach((node) => {
      const groupId = node.data('groupId') as string;
      const style = normaliseGroupDisplay(groups[groupId]?.displayStyle ?? 'rectangle');

      const region = visit(node);
      if (!region.rects.length || !region.bounds) return;

      const loop = style === 'loop' ? snakeLoop(region.leaves, paddingOf(node)) : null;
      /* a band is a union of rectangles — one per centreline segment — so the
         loop shares the outline's hit test and its top edge, and needs neither
         of its own. A rectangle is simply its own overall bounds. */
      const rects = style === 'rectangle' ? [region.bounds] : loop ? bandRects(loop) : region.rects;
      const fit =
        style === 'rectangle' || loop
          ? { rings: [rectRing(region.bounds)] as Ring[], rects }
          : formFit(region.rects);

      const bounds = boundsOf(fit.rects) ?? region.bounds;
      const top = topEdgeOf(fit.rects) ?? { x1: bounds.x1, x2: bounds.x2, y: bounds.y1 };
      /* a grouping that anchors no room has no compound geometry of its own —
         its node is a leaf, positioned and sized to its region by apply() */
      const leaf = node.isChildless();
      const centre = leaf
        ? { x: (bounds.x1 + bounds.x2) / 2, y: (bounds.y1 + bounds.y2) / 2 }
        : node.position();

      this.bodies.push({
        groupId,
        nodeId: node.id(),
        node,
        style,
        zLayer: (node.data('zLayer') as number) || 0,
        rings: fit.rings,
        rects: fit.rects,
        bounds,
        loop,
        leaf,
        titleDx: (top.x1 + top.x2) / 2 - centre.x,
        titleDy: top.y - centre.y
      });
    });

    /* the layering pass walks the tree pre-order, so a parent's zLayer is always
       below its children's: drawing in this order nests correctly by itself */
    this.bodies.sort((a, b) => a.zLayer - b.zLayer);
  }

  /** Publish the title anchor, and — for a leaf grouping — its own position
   *  and size, for the stylesheet and the layout. */
  private apply() {
    const { cy } = this;
    const set = (node: NodeSingular, key: string, value: number) => {
      if (node.data(key) !== value) node.data(key, value);
    };
    const byNode = new Map(this.bodies.map((b) => [b.nodeId, b]));
    cy.batch(() => {
      cy.nodes('.group').forEach((node) => {
        const body = byNode.get(node.id());
        set(node, 'titleDx', body?.titleDx ?? 0);
        set(node, 'titleDy', body?.titleDy ?? 0);
        if (body?.leaf && !node.grabbed()) {
          const b = body.bounds;
          node.position({ x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 });
          set(node, 'leafW', b.x2 - b.x1);
          set(node, 'leafH', b.y2 - b.y1);
        }
      });
    });
  }
}

/** Model-space bounds of whatever the overlay paints for this body. */
export function bodyBounds(body: GroupBody): Rect {
  return body.bounds;
}

/**
 * The title's drawn box, read live from the node so it tracks the view scale —
 * the skeleton's title is several times the size of the detail view's, and both
 * have to be clickable. Mirrors the `text-margin-y` mapper in `style.ts`.
 */
function titleRect(body: GroupBody): Rect | null {
  const n = body.node;
  const titleW = (n.data('titleW') as number) || 0;
  const titleH = (n.data('titleH') as number) || 0;
  if (!titleW || !titleH) return null;
  const tv = (n.data('tView') as number) || 1;
  const centre = n.position();
  const cx = centre.x + body.titleDx;
  const bottom = centre.y + body.titleDy - TITLE_GAP * tv;
  const w = titleW * tv;
  return { x1: cx - w / 2 - 4, x2: cx + w / 2 + 4, y1: bottom - titleH * tv, y2: bottom };
}

/**
 * Is `p` on the grouping's drawn body — or on its title? Nothing else hits: the
 * invisible rectangle the compound node still occupies is not clickable, because
 * there is nothing there to click. The title is included because a snake loop's
 * band is a poor grab target and its title is the obvious one.
 */
export function hitGroupBody(body: GroupBody, p: Pt): boolean {
  const title = titleRect(body);
  if (title && inRect(title, p)) return true;
  for (const r of body.rects) if (inRect(r, p)) return true;
  return false;
}
