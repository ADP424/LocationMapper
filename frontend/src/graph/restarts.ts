import type { Location, LocationLabel } from '../types';

/**
 * A **restart** is a one-way move a *label* grants: every room carrying the
 * label may jump to each of the label's targets. It is never drawn — not even
 * as an ephemeral stub — and it is entirely opt-in. It exists so that a map
 * full of honest one-way connections can still express "and then I went home
 * and started the next day", without anybody having to draw fifty return edges.
 *
 * It is *data about a label*, so it lives nowhere near `connections`: the
 * planner is handed synthetic arcs at plan time and nothing else ever sees them.
 */
export const RESTART_PREFIX = 'restart:';

export const isRestartId = (id: string) => id.startsWith(RESTART_PREFIX);

/** '' is the common case, and "Restart" is what it means. */
export const restartMoveName = (label: Pick<LocationLabel, 'restartName'> | undefined) =>
  (label?.restartName ?? '').trim() || 'Restart';

export const grantsRestarts = (label: Pick<LocationLabel, 'restartTargets'>) =>
  label.restartTargets.length > 0;

export interface RestartLink {
  /** Synthetic, and deliberately not a connection id. */
  id: string;
  labelId: string;
  fromId: string;
  toId: string;
  weight: number;
}

const sane = (w: number) => (Number.isFinite(w) && w >= 0 ? w : 1);

const restartId = (labelId: string, fromId: string, toId: string) =>
  `${RESTART_PREFIX}${labelId}:${fromId}:${toId}`;

/**
 * Every restart arc on the map, deduplicated.
 *
 * Two labels can grant the same `from → to` hop; the cheapest wins, breaking
 * ties by label name so the plan a user sees is stable across reloads. Without
 * this, a popular label multiplies the planner's branching factor for nothing —
 * parallel arcs of equal cost can never both be optimal.
 *
 * A room never restarts to itself, and a target that has been deleted is simply
 * not there (the database drops it; the store mirrors that).
 */
export function buildRestartLinks(
  locations: Record<string, Location>,
  labels: Record<string, LocationLabel>
): RestartLink[] {
  const granting = Object.values(labels)
    .filter(grantsRestarts)
    .sort((a, b) => (a.name || '').localeCompare(b.name || '') || a.id.localeCompare(b.id));
  if (!granting.length) return [];

  const members = new Map<string, string[]>();
  for (const loc of Object.values(locations)) {
    for (const labelId of loc.labelIds) {
      const list = members.get(labelId);
      if (list) list.push(loc.id);
      else members.set(labelId, [loc.id]);
    }
  }

  const best = new Map<string, RestartLink>();
  for (const label of granting) {
    const targets = label.restartTargets.filter((t) => locations[t]);
    const from = members.get(label.id);
    if (!targets.length || !from?.length) continue;
    const weight = sane(label.restartWeight);
    for (const fromId of from) {
      for (const toId of targets) {
        if (toId === fromId) continue;
        const key = `${fromId}>${toId}`;
        const current = best.get(key);
        if (current && current.weight <= weight) continue;
        best.set(key, { id: restartId(label.id, fromId, toId), labelId: label.id, fromId, toId, weight });
      }
    }
  }
  return [...best.values()];
}

/**
 * Every restart this one room may take — *undeduplicated*, because the inspector
 * is showing the user their configuration, not the planner's chosen arc. Two
 * labels granting the same hop is worth seeing.
 */
export function restartsFrom(
  locationId: string,
  locations: Record<string, Location>,
  labels: Record<string, LocationLabel>
): RestartLink[] {
  const loc = locations[locationId];
  if (!loc) return [];
  const out: RestartLink[] = [];
  for (const labelId of loc.labelIds) {
    const label = labels[labelId];
    if (!label || !grantsRestarts(label)) continue;
    for (const toId of label.restartTargets) {
      if (!locations[toId] || toId === locationId) continue;
      out.push({
        id: restartId(labelId, locationId, toId),
        labelId,
        fromId: locationId,
        toId,
        weight: sane(label.restartWeight)
      });
    }
  }
  return out;
}
