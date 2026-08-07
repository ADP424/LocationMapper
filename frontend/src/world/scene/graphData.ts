/**
 * The map, reduced to what the 3D scene needs.
 *
 * A location is drawable only if all three coordinates are set — two out of
 * three is not a point in space, and guessing the third would put a marker
 * somewhere the user never said. Unplaced locations are counted instead, so the
 * sidebar can offer to place them.
 */

import type { Connection, Location } from '../../types';
import type { EdgeDatum } from './edges';
import type { LabelDatum } from './labels';
import type { GraphData } from './worldView';
import type { MarkerDatum } from './markers';

export interface Placed {
  x: number;
  y: number;
  z: number;
}

export function placedAt(location: Location): Placed | null {
  if (location.coordX === null || location.coordY === null || location.coordZ === null) return null;
  return { x: location.coordX, y: location.coordY, z: location.coordZ };
}

export function isPlaced(location: Location): boolean {
  return placedAt(location) !== null;
}

export function buildGraphData(
  locations: Record<string, Location>,
  connections: Record<string, Connection>
): GraphData {
  const markers: MarkerDatum[] = [];
  const labels: LabelDatum[] = [];
  const points = new Map<string, Placed>();

  for (const location of Object.values(locations)) {
    const at = placedAt(location);
    if (!at) continue;
    points.set(location.id, at);
    markers.push({ id: location.id, color: location.color || '#7fb3ff', ...at });
    labels.push({
      id: location.id,
      text: location.name || 'Untitled',
      color: location.color || '#7fb3ff',
      ...at
    });
  }

  const edges: EdgeDatum[] = [];
  for (const connection of Object.values(connections)) {
    const a = points.get(connection.sourceId);
    const b = points.get(connection.targetId);
    if (!a || !b) continue;
    edges.push({
      id: connection.id,
      color: connection.color || '#8aa2c0',
      dashed: connection.ephemeral,
      a,
      b
    });
  }

  /* Stable order keeps instance indices from shuffling between rebuilds, which
     would otherwise make every marker flicker to a new colour on any edit. */
  markers.sort((p, q) => (p.id < q.id ? -1 : 1));
  labels.sort((p, q) => (p.id < q.id ? -1 : 1));
  edges.sort((p, q) => (p.id < q.id ? -1 : 1));

  return { markers, edges, labels };
}
