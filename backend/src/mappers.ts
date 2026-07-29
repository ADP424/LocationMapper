import type {
  Connection,
  ConnectionLabel,
  GraphMap,
  Group,
  Location,
  LocationLabel,
  MapSummary
} from './types';

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

export const mapGroup = (r: any): Group => ({
  id: r.id,
  mapId: r.map_id,
  parentId: r.parent_id ?? null,
  name: r.name,
  color: r.color,
  textColor: r.text_color,
  notes: r.notes,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at)
});

export const mapLocation = (r: any): Location => ({
  id: r.id,
  mapId: r.map_id,
  groupId: r.group_id ?? null,
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
  coordX: r.coord_x === null || r.coord_x === undefined ? null : Number(r.coord_x),
  coordY: r.coord_y === null || r.coord_y === undefined ? null : Number(r.coord_y),
  coordZ: r.coord_z === null || r.coord_z === undefined ? null : Number(r.coord_z),
  labelIds: (r.label_ids ?? []) as string[],
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
  outDx: r.out_dx === null || r.out_dx === undefined ? null : Number(r.out_dx),
  outDy: r.out_dy === null || r.out_dy === undefined ? null : Number(r.out_dy),
  inDx: r.in_dx === null || r.in_dx === undefined ? null : Number(r.in_dx),
  inDy: r.in_dy === null || r.in_dy === undefined ? null : Number(r.in_dy),
  requires: (r.requires ?? []) as string[],
  labelIds: (r.label_ids ?? []) as string[],
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at)
});

export const mapLocationLabel = (r: any): LocationLabel => ({
  id: r.id,
  mapId: r.map_id,
  name: r.name,
  color: r.color,
  notes: r.notes,
  defaultKind: r.default_kind,
  defaultColor: r.default_color,
  defaultTextColor: r.default_text_color,
  defaultLayer: r.default_layer,
  defaultGroupId: r.default_group_id ?? null,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at)
});

export const mapConnectionLabel = (r: any): ConnectionLabel => ({
  id: r.id,
  mapId: r.map_id,
  name: r.name,
  color: r.color,
  notes: r.notes,
  defaultColor: r.default_color,
  defaultTextColor: r.default_text_color,
  defaultTravelKind: r.default_travel_kind,
  defaultDirection: r.default_direction,
  defaultWeight:
    r.default_weight === null || r.default_weight === undefined ? null : Number(r.default_weight),
  defaultEphemeral: r.default_ephemeral ?? null,
  defaultLocked: r.default_locked ?? null,
  defaultLockNote: r.default_lock_note,
  defaultRequires: (r.default_requires ?? []) as string[],
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at)
});
