import cytoscape, { Core, ElementDefinition } from 'cytoscape';
import { LayoutName, computeMetrics, layoutOptions } from './layouts';
import { DEFAULT_GROUP_PADDING } from './model';
import { layoutSpan } from './viewScale';

/** A little air on top of whatever the grouping actually draws, so two
 *  neighbouring boxes never touch. Model geometry — it never scales. */
const PADDING_SLACK = 4;
/** Extra headroom inside a grouping for its title; this *does* scale with Base Size. */
const LABEL_ROOM = 20;
/** Floor for the median-based unit-size cap below, so a container of only a
 *  couple of tiny/uniform units never clamps to something smaller than a
 *  normal room. */
const NOMINAL_UNIT_SPAN = 150;

type Pos = { x: number; y: number };
type Size = { w: number; h: number };

function runLayoutAsync(cy: Core, options: any, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    try {
      const layout = cy.layout(options);
      layout.one('layoutstop', () => {
        clearTimeout(timer);
        done();
      });
      layout.run();
    } catch {
      clearTimeout(timer);
      done();
    }
  });
}

async function layoutHeadless(
  elements: ElementDefinition[],
  name: LayoutName,
  baseScale: number
): Promise<Map<string, Pos>> {
  const positions = new Map<string, Pos>();
  const nodes = elements.filter((el) => !el.data?.source);
  if (!nodes.length) return positions;
  if (nodes.length === 1) {
    positions.set(String(nodes[0].data!.id), { x: 0, y: 0 });
    return positions;
  }

  const cy = cytoscape({
    headless: true,
    styleEnabled: true,
    elements,
    style: [
      {
        selector: 'node',
        style: { shape: 'rectangle', width: 'data(w)', height: 'data(h)', label: '' }
      },
      { selector: 'edge', style: { width: 1, label: '' } }
    ] as any
  });

  try {
    /* measure this container's own geometry: a sub-grouping enters its parent's
       layout as one big node, and over-sized rooms carry their size scalar in
       w/h, so both need the spacing terms computed here rather than globally */
    const metrics = computeMetrics(
      cy.edges().map((e) => (e.data('labelWidth') as number) ?? 0),
      cy.nodes().map((n) => Math.max(Number(n.data('w')) || 0, Number(n.data('h')) || 0)),
      baseScale
    );

    await runLayoutAsync(cy, {
      ...layoutOptions(name === 'preset' ? 'fcose' : name, metrics),
      animate: false,
      fit: false,
      nodeDimensionsIncludeLabels: false
    });
    cy.nodes().forEach((n) => {
      positions.set(n.id(), { ...n.position() });
    });
  } finally {
    cy.destroy();
  }
  return positions;
}

function bboxOf(ids: string[], pos: Map<string, Pos>, size: Map<string, Size>) {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const id of ids) {
    const p = pos.get(`u:${id}`) ?? { x: 0, y: 0 };
    const s = size.get(id) ?? { w: 40, h: 30 };
    x1 = Math.min(x1, p.x - s.w / 2);
    y1 = Math.min(y1, p.y - s.h / 2);
    x2 = Math.max(x2, p.x + s.w / 2);
    y2 = Math.max(y2, p.y + s.h / 2);
  }
  if (!Number.isFinite(x1)) return { w: 0, h: 0, cx: 0, cy: 0 };
  return { w: x2 - x1, h: y2 - y1, cx: (x1 + x2) / 2, cy: (y1 + y2) / 2 };
}

interface ContainerResult {
  size: Size;
  /** Real node -> position relative to this container's centre. */
  offsets: Map<string, Pos>;
}

const ROOT = '__root__';

/**
 * Lay out every container (the canvas itself, each grouping, each sub-grouping)
 * as its own quotient graph, innermost first:
 *
 *   1. a sub-grouping is laid out on its own, which gives it a size
 *   2. its parent then places it as a single big node among its own members
 *   3. positions are translated back down the tree
 *
 * Connections always stay room-to-room, and nothing outside a box can be
 * placed inside it — at any nesting depth.
 */
export async function computeGroupedLayout(
  cy: Core,
  name: LayoutName,
  baseScale = 1
): Promise<Map<string, Pos>> {
  const labelRoom = LABEL_ROOM * baseScale;
  /** Each grouping reserves exactly the room its own body will occupy. */
  const paddingOf = (level: string | null) => {
    if (!level) return DEFAULT_GROUP_PADDING + PADDING_SLACK;
    const p = cy.getElementById(level).data('bodyPadding') as number;
    return (Number.isFinite(p) && p >= 0 ? p : DEFAULT_GROUP_PADDING) + PADDING_SLACK;
  };

  const realNodes = cy
    .nodes()
    .filter((n) => !n.hasClass('group') && !n.hasClass('ghost') && !n.hasClass('handle'));
  if (!realNodes.length) return new Map();

  const groupNodes = cy.nodes('.group');
  const edges = cy.edges().filter((e) => !e.hasClass('ghost-edge') && !e.hasClass('reconnect-edge'));

  /* layoutSpan() carries each location's size scalar *and* its name plate
     (whichever is bigger), so a 3x room — or a 1x room with a huge name —
     really is solved at that footprint at every level of nesting */
  const size = new Map<string, Size>();
  realNodes.forEach((n) => {
    const b = layoutSpan(n);
    size.set(n.id(), { w: Math.max(b.w, 30), h: Math.max(b.h, 24) });
  });

  /* ---- containment -------------------------------------------------- */
  const parentOfGroup = new Map<string, string | null>();
  groupNodes.forEach((g) => {
    const p = g.parent();
    parentOfGroup.set(g.id(), p.nonempty() ? p.first().id() : null);
  });

  const childGroups = new Map<string | null, string[]>();
  const childNodes = new Map<string | null, string[]>();
  const push = (map: Map<string | null, string[]>, key: string | null, id: string) => {
    const list = map.get(key) ?? [];
    list.push(id);
    map.set(key, list);
  };
  /* a grouping that anchors nobody (every membership is someone else's
     anchor) is a childless compound node — GroupBodyStore positions and sizes
     it directly from its drawn region, so it takes no container slot here and
     reserves no phantom hole in its nesting parent's layout */
  groupNodes.forEach((g) => {
    if (g.isChildless()) return;
    push(childGroups, parentOfGroup.get(g.id()) ?? null, g.id());
  });
  realNodes.forEach((n) => {
    const p = n.parent();
    push(childNodes, p.nonempty() ? p.first().id() : null, n.id());
  });

  /** Ancestor chain for each real node, innermost first. */
  const chains = new Map<string, string[]>();
  realNodes.forEach((n) => {
    const chain: string[] = [];
    const p = n.parent();
    let cur: string | null = p.nonempty() ? p.first().id() : null;
    const guard = new Set<string>();
    while (cur && !guard.has(cur)) {
      guard.add(cur);
      chain.push(cur);
      cur = parentOfGroup.get(cur) ?? null;
    }
    chains.set(n.id(), chain);
  });

  const inside = (nodeId: string, level: string | null) =>
    level === null || (chains.get(nodeId) ?? []).includes(level);

  /** Which direct child of `level` contains `nodeId`. */
  const unitAt = (nodeId: string, level: string | null): string | null => {
    const chain = chains.get(nodeId) ?? [];
    if (level === null) return chain.length ? chain[chain.length - 1] : nodeId;
    const idx = chain.indexOf(level);
    if (idx === -1) return null;
    return idx === 0 ? nodeId : chain[idx - 1];
  };

  /* ---- cohesion ------------------------------------------------------ */
  /* A membership that doesn't anchor a room still pulls it: each grouping adds
     hub-and-spoke virtual edges over its members, which merge into the
     quotient graphs exactly like real connections. A room in two groupings is
     pulled toward both — membership behaves like membership, even where it
     isn't containment. */
  const cohesion: Array<[string, string]> = [];
  {
    const byGroup = new Map<string, string[]>();
    realNodes.forEach((n) => {
      const raw = (n.data('memberOf') as string) || '';
      if (!raw) return;
      for (const gid of raw.split(',')) {
        const list = byGroup.get(gid) ?? [];
        list.push(n.id());
        byGroup.set(gid, list);
      }
    });
    byGroup.forEach((ids) => {
      for (let i = 1; i < ids.length; i++) cohesion.push([ids[0], ids[i]]);
    });
  }

  /* ---- recursive layout --------------------------------------------- */
  const results = new Map<string, ContainerResult>();

  const layoutContainer = async (level: string | null): Promise<void> => {
    const padding = paddingOf(level);
    const groups = childGroups.get(level) ?? [];
    const nodes = childNodes.get(level) ?? [];
    for (const gid of groups) await layoutContainer(gid);

    const unitSize = new Map<string, Size>();
    for (const gid of groups) unitSize.set(gid, results.get(gid)!.size);
    for (const nid of nodes) unitSize.set(nid, size.get(nid)!);

    if (unitSize.size === 0) {
      results.set(level ?? ROOT, { size: { w: 60, h: 40 }, offsets: new Map() });
      return;
    }

    /* breadthfirst/concentric/grid's avoidOverlap solves one *global* spacing
       floor — `minDistance = max(w, h)` over every unit in the container —
       and uses it between every pair, not just the pair that's actually big.
       A nested sub-grouping's own box is a unit here, and it can legitimately
       run to thousands of px while its sibling rooms sit around 100-200px; fed
       in raw, that single outlier inflates the gap between every *other*,
       ordinary-sized pair too, and since this container's own resulting box
       becomes one unit in *its* parent's pass, the inflation compounds every
       level up the group tree. fCoSE never needed this clamp — its spacing is
       pairwise (ideal edge length / repulsion), not one shared scalar — so it
       keeps seeing each unit's real size. */
    const capFor = (() => {
      if (name === 'fcose' || name === 'preset') return (s: Size) => s;
      const spans = [...unitSize.values()].map((s) => Math.max(s.w, s.h)).sort((a, b) => a - b);
      const median = spans[Math.floor(spans.length / 2)] ?? 0;
      const cap = Math.max(median * 3, NOMINAL_UNIT_SPAN);
      return (s: Size) => ({ w: Math.min(s.w, cap), h: Math.min(s.h, cap) });
    })();

    const els: ElementDefinition[] = [];
    unitSize.forEach((s, id) => {
      const c = capFor(s);
      els.push({ data: { id: `u:${id}`, w: c.w, h: c.h } });
    });

    const merged = new Map<string, number>();
    edges.forEach((e) => {
      const s = e.source().id();
      const t = e.target().id();
      if (!size.has(s) || !size.has(t)) return;
      if (!inside(s, level) || !inside(t, level)) return;
      const su = unitAt(s, level);
      const tu = unitAt(t, level);
      if (!su || !tu || su === tu) return;
      const key = `${su} ${tu}`;
      merged.set(key, Math.max(merged.get(key) ?? 0, (e.data('labelWidth') as number) ?? 0));
    });
    /* members of one grouping anchored in the same container collapse to
       su === tu (a no-op, containment already did that job); members
       scattered across containers pull those containers together, at every
       nesting level, through the same quotient-edge machinery as real edges */
    for (const [s, t] of cohesion) {
      if (!size.has(s) || !size.has(t)) continue;
      if (!inside(s, level) || !inside(t, level)) continue;
      const su = unitAt(s, level);
      const tu = unitAt(t, level);
      if (!su || !tu || su === tu) continue;
      const key = `${su} ${tu}`;
      if (!merged.has(key)) merged.set(key, 0);
    }

    let i = 0;
    merged.forEach((labelWidth, key) => {
      const [su, tu] = key.split(' ');
      els.push({ data: { id: `m${i++}`, source: `u:${su}`, target: `u:${tu}`, labelWidth } });
    });

    const placed = await layoutHeadless(els, name, baseScale);
    const box = bboxOf([...unitSize.keys()], placed, unitSize);

    const offsets = new Map<string, Pos>();
    unitSize.forEach((_s, id) => {
      const p = placed.get(`u:${id}`) ?? { x: 0, y: 0 };
      const rel = { x: p.x - box.cx, y: p.y - box.cy };
      const sub = results.get(id);
      if (sub) sub.offsets.forEach((o, nodeId) => offsets.set(nodeId, { x: rel.x + o.x, y: rel.y + o.y }));
      else offsets.set(id, rel);
    });

    results.set(level ?? ROOT, {
      size: { w: box.w + padding * 2, h: box.h + padding * 2 + labelRoom },
      offsets
    });
  };

  await layoutContainer(null);
  return results.get(ROOT)?.offsets ?? new Map();
}
