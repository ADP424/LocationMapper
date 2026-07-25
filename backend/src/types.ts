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

export interface Location {
  id: string;
  mapId: string;
  name: string;
  /** Node shape key, e.g. round-rectangle / hexagon / star. */
  kind: string;
  layer: string;
  notes: string;
  color: string;
  textColor: string;
  visited: boolean;
  pinned: boolean;
  x: number | null;
  y: number | null;
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
  /** Line style key: solid | dashed | dotted. */
  travelKind: string;
  color: string;
  textColor: string;
  /** Arrowheads are independent; both may be false. */
  arrowSource: boolean;
  arrowTarget: boolean;
  ephemeral: boolean;
  locked: boolean;
  lockNote: string;
  weight: number;
  requires: string[];
  createdAt: string;
  updatedAt: string;
}

export interface GraphPayload {
  map: GraphMap;
  locations: Location[];
  connections: Connection[];
}
