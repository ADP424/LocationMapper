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
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

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
  size: Number(r.size ?? 1),
  layer: r.layer,
  notes: r.notes,
  color: r.color,
  textColor: r.text_color,
  visited: r.visited,
  x: num(r.x),
  y: num(r.y),
  coordX: num(r.coord_x),
  coordY: num(r.coord_y),
  coordZ: num(r.coord_z),
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
  outDx: num(r.out_dx),
  outDy: num(r.out_dy),
  inDx: num(r.in_dx),
  inDy: num(r.in_dy),
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
  defaultSize: num(r.default_size),
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
  defaultWeight: num(r.default_weight),
  defaultEphemeral: r.default_ephemeral ?? null,
  defaultLocked: r.default_locked ?? null,
  defaultLockNote: r.default_lock_note,
  defaultRequires: (r.default_requires ?? []) as string[],
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at)
});
