export interface MapSummary {
  id: string;
  name: string;
  description: string;
  locationCount: number;
  connectionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface GraphMap {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

/** A visual grouping of locations ("House", "Old Town", "Deck 4"). */
export interface Group {
  id: string;
  mapId: string;
  parentId: string | null;
  name: string;
  color: string;
  textColor: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface Location {
  id: string;
  mapId: string;
  groupId: string | null;
  name: string;
  kind: string; // shape key
  /** Scalar on the drawn box, relative to every other location. */
  size: number;
  layer: string;
  notes: string;
  color: string;
  textColor: string;
  visited: boolean;
  x: number | null;
  y: number | null;
  /** Logical grid coordinates. Whole numbers, negatives allowed, NULL = unset. */
  coordX: number | null;
  coordY: number | null;
  coordZ: number | null;
  /** Applied labels, oldest first. */
  labelIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Connection {
  id: string;
  mapId: string;
  sourceId: string;
  targetId: string;
  name: string;
  notes: string;
  travelKind: string; // line style key
  color: string;
  textColor: string;
  arrowSource: boolean;
  arrowTarget: boolean;
  ephemeral: boolean;
  locked: boolean;
  lockNote: string;
  weight: number;
  /** Offsets of the ephemeral stub boxes from their anchor room. */
  outDx: number | null;
  outDy: number | null;
  inDx: number | null;
  inDy: number | null;
  requires: string[];
  labelIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** A reusable style/grouping preset that can be stamped onto locations. */
export interface LocationLabel {
  id: string;
  mapId: string;
  name: string;
  color: string;
  notes: string;
  defaultKind: string;
  defaultSize: number | null;
  defaultColor: string;
  defaultTextColor: string;
  defaultLayer: string;
  defaultGroupId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A reusable style/unlock preset that can be stamped onto connections. */
export interface ConnectionLabel {
  id: string;
  mapId: string;
  name: string;
  color: string;
  notes: string;
  defaultColor: string;
  defaultTextColor: string;
  defaultTravelKind: string;
  defaultDirection: string;
  defaultWeight: number | null;
  defaultEphemeral: boolean | null;
  defaultLocked: boolean | null;
  defaultLockNote: string;
  defaultRequires: string[];
  createdAt: string;
  updatedAt: string;
}

export interface GraphPayload {
  map: GraphMap;
  groups: Group[];
  locationLabels: LocationLabel[];
  connectionLabels: ConnectionLabel[];
  locations: Location[];
  connections: Connection[];
}
