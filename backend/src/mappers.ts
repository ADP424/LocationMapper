import type { Connection, GraphMap, Location, MapSummary } from './types';

const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : String(v));

export const mapMap = (r: any): GraphMap => ({
  id: r.id,
  name: r.name,
  description: r.description,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at)
});

export const mapMapSummary = (r: any): MapSummary => ({
  ...mapMap(r),
  locationCount: Number(r.location_count ?? 0),
  connectionCount: Number(r.connection_count ?? 0)
});

export const mapLocation = (r: any): Location => ({
  id: r.id,
  mapId: r.map_id,
  name: r.name,
  kind: r.kind,
  layer: r.layer,
  notes: r.notes,
  color: r.color,
  textColor: r.text_color,
  visited: r.visited,
  pinned: r.pinned,
  x: r.x === null || r.x === undefined ? null : Number(r.x),
  y: r.y === null || r.y === undefined ? null : Number(r.y),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at)
});

export const mapConnection = (r: any): Connection => ({
  id: r.id,
  mapId: r.map_id,
  sourceId: r.source_id,
  targetId: r.target_id,
  name: r.name,
  notes: r.notes,
  travelKind: r.travel_kind,
  color: r.color,
  textColor: r.text_color,
  arrowSource: r.arrow_source,
  arrowTarget: r.arrow_target,
  ephemeral: r.ephemeral,
  locked: r.locked,
  lockNote: r.lock_note,
  weight: Number(r.weight ?? 1),
  requires: (r.requires ?? []) as string[],
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at)
});
