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
  kind: string; // shape key
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
  travelKind: string; // line style key
  color: string;
  textColor: string;
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

export type Selection =
  | { type: 'location'; id: string }
  | { type: 'connection'; id: string };

export interface ContextMenuState {
  /** Screen coordinates relative to the graph container. */
  x: number;
  y: number;
  /** Model coordinates inside the graph. */
  graphX: number;
  graphY: number;
  /** Present when the menu was opened on a location. */
  locationId?: string;
}
