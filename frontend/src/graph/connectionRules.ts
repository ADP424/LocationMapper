/**
 * The single source of truth for how a connection may be walked and when it is
 * shut. Imported by the renderer *and* the planner (worker-safe: types only).
 */

export interface DirectionalConnection {
  arrowSource: boolean;
  arrowTarget: boolean;
}

export interface GatedConnection {
  locked: boolean;
  requires: string[];
}

export interface TraversalDirections {
  /** source -> target may be walked */
  forward: boolean;
  /** target -> source may be walked */
  backward: boolean;
}

/**
 * An arrowhead marks an end you may arrive at. A connection drawn with *no*
 * arrowheads is a plain undirected link and is walkable both ways — the arrow
 * toggle is presentation, not permission.
 */
export function traversalDirections(c: DirectionalConnection): TraversalDirections {
  if (!c.arrowSource && !c.arrowTarget) return { forward: true, backward: true };
  return { forward: c.arrowTarget, backward: c.arrowSource };
}

export function unmetRequirements(c: GatedConnection, visited: ReadonlySet<string>): string[] {
  if (!c.locked) return [];
  return c.requires.filter((id) => !visited.has(id));
}

/** Locked with no unlock condition recorded: sealed for good. */
export function isPermanentlySealed(c: GatedConnection): boolean {
  return c.locked && c.requires.length === 0;
}

export function isEffectivelyLocked(c: GatedConnection, visited: ReadonlySet<string>): boolean {
  if (!c.locked) return false;
  if (c.requires.length === 0) return true;
  return unmetRequirements(c, visited).length > 0;
}
