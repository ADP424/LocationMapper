export interface MapSummary {
  id: string;
  name: string;
  description: string;
  /** Where a new trip begins; null = none. */
  startLocationId: string | null;
  locationCount: number;
  connectionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface GraphMap {
  id: string;
  name: string;
  description: string;
  /** Where a new trip begins; null = none. Cleared when that location is deleted. */
  startLocationId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** How a grouping's body is drawn behind its members. */
export type GroupDisplayStyle =
  /** One translucent rounded rectangle over the grouping's whole extent. */
  | 'rectangle'
  /** A rectilinear outline form-fitted to the members, hard right angles. */
  | 'outline'
  /** A closed orthogonal band threaded through every member — a snake loop. */
  | 'loop';

/** A visual grouping of locations ("House", "Old Town", "Deck 4"). */
export interface Group {
  id: string;
  mapId: string;
  parentId: string | null;
  name: string;
  color: string;
  textColor: string;
  notes: string;
  /** How the body behind the members is drawn. */
  displayStyle: GroupDisplayStyle;
  /** How far that body extends past its rooms, in model pixels. null = app default. */
  bodyPadding: number | null;
  /** Stamped onto rooms *created* inside this grouping; '' / null = no override. */
  defaultKind: string;
  defaultSize: number | null;
  defaultColor: string;
  defaultTextColor: string;
  /** Stamp over properties the room's labels already claim. */
  overrideLabels: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Location {
  id: string;
  mapId: string;
  /** Every grouping this room belongs to, oldest first. [0] is the layout anchor. */
  groupIds: string[];
  name: string;
  kind: string; // shape key
  /** Scalar on the drawn box, relative to every other location. */
  size: number;
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
  /** Stamp over properties the room's groupings already claim. */
  overrideGroupings: boolean;
  /**
   * Every room carrying this label gains a one-way "restart" move to each of
   * these locations. Never drawn; the trip planner uses them only when the trip
   * allows restarts. Structure, not styling — never stamped onto anything.
   */
  restartTargets: string[];
  /** What to call the move. '' renders as "Restart". */
  restartName: string;
  /** Cost of one restart, in the same units as a connection's weight. */
  restartWeight: number;
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
