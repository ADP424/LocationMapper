import cytoscape, { Core, ElementDefinition } from 'cytoscape';
import { LayoutMetrics, LayoutName, layoutOptions } from './layouts';
import { baseSize } from './viewScale';

export const GROUP_PADDING = 34;
/** Extra headroom inside a grouping for its title. */
const LABEL_ROOM = 20;

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
  metrics: LayoutMetrics
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
    await runLayoutAsync(cy, {
      ...layoutOptions(name === 'preset' ? 'fcose' : name, {
        ...metrics,
        nodeCount: cy.nodes().length
      }),
      animate: false,
      fit: false,
      nodeDimensionsIncludeLabels: false
    });
    cy.nodes().forEach((n) => { positions.set(n.id(), { ...n.position() }); });
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
  metrics: LayoutMetrics
): Promise<Map<string, Pos>> {
  const realNodes = cy
    .nodes()
    .filter((n) => !n.hasClass('group') && !n.hasClass('ghost') && !n.hasClass('handle'));
  if (!realNodes.length) return new Map();

  const groupNodes = cy.nodes('.group');
  const edges = cy
    .edges()
    .filter((e) => !e.hasClass('ghost-edge') && !e.hasClass('reconnect-edge'));

  const size = new Map<string, Size>();
  realNodes.forEach((n) => {
    const b = baseSize(n);
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
  groupNodes.forEach((g) => push(childGroups, parentOfGroup.get(g.id()) ?? null, g.id()));
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

  /* ---- recursive layout --------------------------------------------- */
  const results = new Map<string, ContainerResult>();

  const layoutContainer = async (level: string | null): Promise<void> => {
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

    const els: ElementDefinition[] = [];
    unitSize.forEach((s, id) => els.push({ data: { id: `u:${id}`, w: s.w, h: s.h } }));

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

    let i = 0;
    merged.forEach((labelWidth, key) => {
      const [su, tu] = key.split(' ');
      els.push({ data: { id: `m${i++}`, source: `u:${su}`, target: `u:${tu}`, labelWidth } });
    });

    const placed = await layoutHeadless(els, name, metrics);
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
      size: { w: box.w + GROUP_PADDING * 2, h: box.h + GROUP_PADDING * 2 + LABEL_ROOM },
      offsets
    });
  };

  await layoutContainer(null);
  return results.get(ROOT)?.offsets ?? new Map();
}
