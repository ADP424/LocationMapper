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
  kind: string;
  /** Scalar on the drawn box, relative to every other location. */
  size: number;
  notes: string;
  color: string;
  textColor: string;
  visited: boolean;
  x: number | null;
  y: number | null;
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
  travelKind: string;
  color: string;
  textColor: string;
  arrowSource: boolean;
  arrowTarget: boolean;
  ephemeral: boolean;
  locked: boolean;
  lockNote: string;
  weight: number;
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

export type Selection =
  | { type: 'location'; id: string }
  | { type: 'connection'; id: string }
  | { type: 'group'; id: string }
  | { type: 'location-label'; id: string }
  | { type: 'connection-label'; id: string };

export interface ContextMenuState {
  /** Viewport (client) coordinates — menus render in a portal. */
  x: number;
  y: number;
  graphX: number;
  graphY: number;
  locationId?: string;
  groupId?: string;
}

export interface PortalOffset {
  connectionId: string;
  side: 'out' | 'in';
  dx: number;
  dy: number;
}
