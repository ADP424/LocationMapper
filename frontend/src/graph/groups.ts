import type { Group, Location } from '../types';

export interface GroupTreeNode {
  group: Group;
  depth: number;
  children: GroupTreeNode[];
}

/** Nested, name-sorted tree. Any group caught in a cycle is surfaced as a root. */
export function buildGroupTree(groups: Group[]): GroupTreeNode[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const childrenOf = new Map<string | null, Group[]>();

  for (const g of groups) {
    const parent = g.parentId && g.parentId !== g.id && byId.has(g.parentId) ? g.parentId : null;
    const list = childrenOf.get(parent) ?? [];
    list.push(g);
    childrenOf.set(parent, list);
  }

  const seen = new Set<string>();
  const build = (parent: string | null, depth: number): GroupTreeNode[] =>
    (childrenOf.get(parent) ?? [])
      .slice()
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      .filter((g) => !seen.has(g.id))
      .map((g) => {
        seen.add(g.id);
        return { group: g, depth, children: build(g.id, depth + 1) };
      });

  const roots = build(null, 0);
  for (const g of groups) {
    if (!seen.has(g.id)) {
      seen.add(g.id);
      roots.push({ group: g, depth: 0, children: [] });
    }
  }
  return roots;
}

export function flattenGroupTree(nodes: GroupTreeNode[], out: GroupTreeNode[] = []) {
  for (const n of nodes) {
    out.push(n);
    flattenGroupTree(n.children, out);
  }
  return out;
}

/** The group itself plus everything nested underneath it. */
export function descendantGroupIds(groups: Group[], rootId: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const g of groups) {
    if (!g.parentId) continue;
    const list = children.get(g.parentId) ?? [];
    list.push(g.id);
    children.set(g.parentId, list);
  }
  const out = new Set<string>([rootId]);
  const stack = [rootId];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const child of children.get(cur) ?? []) {
      if (out.has(child)) continue;
      out.add(child);
      stack.push(child);
    }
  }
  return out;
}

/** "House › Upstairs › Bedroom" */
export function groupPathLabel(groups: Record<string, Group>, id: string): string {
  const parts: string[] = [];
  const guard = new Set<string>();
  let cur: string | null | undefined = id;
  while (cur && groups[cur] && !guard.has(cur)) {
    guard.add(cur);
    parts.unshift(groups[cur].name || 'Unnamed Grouping');
    cur = groups[cur].parentId;
  }
  return parts.join(' › ');
}

/** Does this grouping claim any room styling at all? */
export function hasGroupDefaults(g: Group): boolean {
  return !!(g.defaultKind || g.defaultColor || g.defaultTextColor) || g.defaultSize !== null;
}

/** The layout anchor: the oldest membership — the grouping whose compound box
 *  actually contains this room. Every other membership merely draws a body
 *  around it. */
export const anchorGroupId = (l: Pick<Location, 'groupIds'>): string | null =>
  l.groupIds[0] ?? null;

/** group id -> member location ids, membership order preserved. */
export function membersByGroup(locations: Iterable<Location>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const l of locations) {
    for (const gid of l.groupIds) {
      const list = out.get(gid);
      if (list) list.push(l.id);
      else out.set(gid, [l.id]);
    }
  }
  return out;
}

/** Groups that should be drawn: those with rooms, plus all of their ancestors. */
export function renderableGroupIds(
  groups: Group[],
  directMemberCount: Map<string, number>
): Set<string> {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const out = new Set<string>();
  for (const [gid, count] of directMemberCount) {
    if (count <= 0 || !byId.has(gid)) continue;
    const guard = new Set<string>();
    let cur: string | null | undefined = gid;
    while (cur && byId.has(cur) && !guard.has(cur)) {
      guard.add(cur);
      out.add(cur);
      cur = byId.get(cur)!.parentId;
    }
  }
  return out;
}
