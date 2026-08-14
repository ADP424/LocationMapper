import type { Core } from 'cytoscape';
import type { Connection, Location } from '../types';
import { layoutSpan } from './viewScale';

export type CoordinatePlane = 'xy' | 'xz' | 'yz';
export type Axis = 'x' | 'y' | 'z';

export interface LocationCoords {
  coordX: number | null;
  coordY: number | null;
  coordZ: number | null;
}

/** First axis = horizontal, second axis = vertical. */
export const PLANE_AXES: Record<CoordinatePlane, { h: Axis; v: Axis }> = {
  xy: { h: 'x', v: 'y' },
  xz: { h: 'x', v: 'z' },
  yz: { h: 'y', v: 'z' }
};

/* grid constraints ------------------------------------------------------- */
const MARGIN_X = 46;
const MARGIN_Y = 34;
const MIN_UNIT = 48;
const EDGE_LABEL_PAD = 36;
const CLUSTER_GAP = 16;
const MAX_WINDOW = 32;

/* free-floating elements may sit a little closer so they fit in the gaps */
const FREE_MARGIN_X = 26;
const FREE_MARGIN_Y = 20;
const STUB_MARGIN_X = 16;
const STUB_MARGIN_Y = 12;
const RELAX_ITERATIONS = 80;

interface Cell {
  h: number;
  v: number;
  w: number;
  ht: number;
  offsets: Array<{ id: string; dx: number; dy: number }>;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  dead?: boolean;
}

export interface CoordinateLayoutInput {
  locations: Record<string, Location>;
  connections: Record<string, Connection>;
  /** Skip the auto-solve and use this many pixels per coordinate step instead. */
  fixedUnit?: number;
}

export interface CoordinateLayoutResult {
  positions: Map<string, { x: number; y: number }>;
  /** pixels between two consecutive coordinates — identical on both axes */
  unit: number;
  placedByCoords: number;
  /** rooms positioned from their connections instead of coordinates */
  placedByNeighbours: number;
  /** rooms with neither coordinates nor any placed neighbour */
  seeded: number;
}

export const coordValue = (c: LocationCoords, axis: Axis) =>
  axis === 'x' ? c.coordX : axis === 'y' ? c.coordY : c.coordZ;

const ALL_AXES: Axis[] = ['x', 'y', 'z'];

/** The axis a plane does *not* show — the one groupings are stacked along. */
export const offPlaneAxis = (plane: CoordinatePlane): Axis =>
  ALL_AXES.find((a) => a !== PLANE_AXES[plane].h && a !== PLANE_AXES[plane].v)!;

export function formatCoordinates(c: LocationCoords): string {
  if (c.coordX === null && c.coordY === null && c.coordZ === null) return '';
  const part = (v: number | null) => (v === null ? '—' : String(v));
  return `(${part(c.coordX)}, ${part(c.coordY)}, ${part(c.coordZ)})`;
}

/* ------------------------------------------------------- collision index */
function createIndex(cellSize: number) {
  const buckets = new Map<string, Box[]>();

  const range = (b: Box, padX: number, padY: number) => ({
    x1: Math.floor((b.x - b.w / 2 - padX) / cellSize),
    x2: Math.floor((b.x + b.w / 2 + padX) / cellSize),
    y1: Math.floor((b.y - b.h / 2 - padY) / cellSize),
    y2: Math.floor((b.y + b.h / 2 + padY) / cellSize)
  });

  return {
    insert(b: Box) {
      const r = range(b, 0, 0);
      for (let i = r.x1; i <= r.x2; i++) {
        for (let j = r.y1; j <= r.y2; j++) {
          const key = `${i}|${j}`;
          const list = buckets.get(key);
          if (list) list.push(b);
          else buckets.set(key, [b]);
        }
      }
      return b;
    },
    remove(b: Box) {
      b.dead = true;
    },
    collides(b: Box, padX: number, padY: number) {
      const r = range(b, padX, padY);
      for (let i = r.x1; i <= r.x2; i++) {
        for (let j = r.y1; j <= r.y2; j++) {
          const list = buckets.get(`${i}|${j}`);
          if (!list) continue;
          for (const o of list) {
            if (o.dead || o === b) continue;
            if (
              Math.abs(o.x - b.x) < (o.w + b.w) / 2 + padX &&
              Math.abs(o.y - b.y) < (o.h + b.h) / 2 + padY
            ) {
              return true;
            }
          }
        }
      }
      return false;
    }
  };
}

type Index = ReturnType<typeof createIndex>;

/** The desired spot if it is free, otherwise the nearest free spot outward. */
function findSpot(
  index: Index,
  desired: { x: number; y: number },
  size: { w: number; h: number },
  padX: number,
  padY: number,
  step: number
) {
  const probe: Box = { x: desired.x, y: desired.y, w: size.w, h: size.h };
  if (!index.collides(probe, padX, padY)) return { x: desired.x, y: desired.y };

  const ANGLES = 16;
  for (let ring = 1; ring <= 48; ring++) {
    const radius = ring * step;
    /* offset every other ring so the spiral does not line up with itself */
    const twist = (ring % 2) * (Math.PI / ANGLES);
    for (let a = 0; a < ANGLES; a++) {
      const angle = (a / ANGLES) * Math.PI * 2 + twist;
      probe.x = desired.x + Math.cos(angle) * radius;
      probe.y = desired.y + Math.sin(angle) * radius;
      if (!index.collides(probe, padX, padY)) return { x: probe.x, y: probe.y };
    }
  }
  return { x: desired.x, y: desired.y + 49 * step };
}

const centroid = (points: Array<{ x: number; y: number }>) => {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
};

/**
 * Snap every room with coordinates onto a square lattice, then place everything
 * else by connectivity.
 *
 *  1. One shared `unit` (pixels per coordinate step) satisfies every pair of
 *     occupied coordinates — `unit ≥ min(needH/Δh, needV/Δv)`, since a pair is
 *     comfortable as soon as one axis separates the boxes — plus every labelled
 *     connection's `(labelWidth + pad) / distance`. Because the value is shared,
 *     the grid lines up horizontally and vertically.
 *  2. Rooms sharing a coordinate are clustered inside their cell.
 *  3. Rooms without coordinates for this plane, but with at least one placed
 *     neighbour (directly or transitively), are positioned by Gauss–Seidel
 *     relaxation: each free room repeatedly moves to the centroid of *all* its
 *     neighbours (placed rooms act as fixed anchors), which converges to the
 *     midpoint for two anchors and to even spacing along a chain between them.
 *     Each settled room is then spiralled out of any collision. Rooms with no
 *     placed neighbour at all are seeded beside the grid first so their own
 *     neighbours have something to relax toward.
 *  4. Ephemeral stubs are placed last, at their saved offset or pointing at the
 *     partner room, again avoiding collisions.
 */
export function computeCoordinateLayout(
  cy: Core,
  plane: CoordinatePlane,
  graph: CoordinateLayoutInput
): CoordinateLayoutResult {
  const axes = PLANE_AXES[plane];

  const nodes = cy
    .nodes('.location')
    .filter((n) => !n.hasClass('ghost') && !n.hasClass('handle'));
  if (!nodes.length) {
    return {
      positions: new Map(),
      unit: MIN_UNIT,
      placedByCoords: 0,
      placedByNeighbours: 0,
      seeded: 0
    };
  }

  const size = new Map<string, { w: number; h: number }>();
  nodes.forEach((n) => {
    /* the cell has to hold the name plate too, or a grid of 1x rooms with long
       names at a high Base Size would be a grid of overlapping plates */
    const b = layoutSpan(n);
    size.set(n.id(), { w: Math.max(b.w, 40), h: Math.max(b.h, 30) });
  });

  /* ---------------------------------------------------- bucket by coordinate */
  const grouped = new Map<string, string[]>();
  const freeIds: string[] = [];

  nodes.forEach((n) => {
    const c = graph.locations[n.id()];
    const h = c ? coordValue(c, axes.h) : null;
    const v = c ? coordValue(c, axes.v) : null;
    if (h === null || h === undefined || v === null || v === undefined) {
      freeIds.push(n.id());
      return;
    }
    const key = `${Math.round(h)}|${Math.round(v)}`;
    const list = grouped.get(key) ?? [];
    list.push(n.id());
    grouped.set(key, list);
  });

  /* --------------------------------- cluster co-located rooms inside a cell */
  const cellMap = new Map<string, Cell>();
  for (const [key, ids] of grouped) {
    const [hs, vs] = key.split('|');
    const cols = Math.max(1, Math.ceil(Math.sqrt(ids.length)));
    const rows: string[][] = [];
    for (let i = 0; i < ids.length; i += cols) rows.push(ids.slice(i, i + cols));

    const rowSizes = rows.map((row) => ({
      w: row.reduce((acc, id, i) => acc + size.get(id)!.w + (i ? CLUSTER_GAP : 0), 0),
      h: row.reduce((m, id) => Math.max(m, size.get(id)!.h), 0)
    }));
    const totalW = rowSizes.reduce((m, r) => Math.max(m, r.w), 0);
    const totalH = rowSizes.reduce((acc, r, i) => acc + r.h + (i ? CLUSTER_GAP : 0), 0);

    const offsets: Cell['offsets'] = [];
    let y = -totalH / 2;
    rows.forEach((row, ri) => {
      const rs = rowSizes[ri];
      let x = -rs.w / 2;
      for (const id of row) {
        const s = size.get(id)!;
        offsets.push({ id, dx: x + s.w / 2, dy: y + rs.h / 2 });
        x += s.w + CLUSTER_GAP;
      }
      y += rs.h + CLUSTER_GAP;
    });

    cellMap.set(key, { h: Number(hs), v: Number(vs), w: totalW, ht: totalH, offsets });
  }

  /* --------------------------------------- one unit shared by both axes ---- */
  const cellOf = new Map<string, Cell>();
  cellMap.forEach((c) => c.offsets.forEach((o) => cellOf.set(o.id, c)));
  const cells = [...cellMap.values()];

  let unit: number;
  if (graph.fixedUnit && graph.fixedUnit > 0) {
    /* the user has pinned a spacing — cells sharing a coordinate still cluster
       above, but no cell pair may influence this value */
    unit = graph.fixedUnit;
  } else {
    unit = MIN_UNIT;
    let maxNeed = 0;
    cellMap.forEach((c) => {
      maxNeed = Math.max(maxNeed, c.w + MARGIN_X, c.ht + MARGIN_Y);
    });

    const window = Math.min(MAX_WINDOW, Math.max(1, Math.ceil(maxNeed / MIN_UNIT)));

    for (const a of cells) {
      for (let dh = -window; dh <= window; dh++) {
        for (let dv = -window; dv <= window; dv++) {
          if (dh === 0 && dv === 0) continue;
          const b = cellMap.get(`${a.h + dh}|${a.v + dv}`);
          if (!b) continue;
          if (b.h < a.h || (b.h === a.h && b.v <= a.v)) continue;

          const needH = (a.w + b.w) / 2 + MARGIN_X;
          const needV = (a.ht + b.ht) / 2 + MARGIN_Y;
          const reqH = dh === 0 ? Infinity : needH / Math.abs(dh);
          const reqV = dv === 0 ? Infinity : needV / Math.abs(dv);
          unit = Math.max(unit, Math.min(reqH, reqV));
        }
      }
    }

    /* ----------------------------- connection names need room on the line */
    cy.edges().forEach((e) => {
      if (e.hasClass('ghost-edge') || e.hasClass('reconnect-edge') || e.hasClass('stub')) return;
      const labelWidth = (e.data('labelWidth') as number) ?? 0;
      if (labelWidth <= 0) return;
      const a = cellOf.get(e.source().id());
      const b = cellOf.get(e.target().id());
      if (!a || !b) return;
      const dist = Math.hypot(b.h - a.h, b.v - a.v);
      if (dist === 0) return;
      /* the two boxes eat into the line the name has to sit on, so over-sized
         rooms need proportionally more grid between them */
      const clearance =
        ((size.get(e.source().id())?.w ?? 0) + (size.get(e.target().id())?.w ?? 0)) / 2;
      unit = Math.max(unit, (labelWidth + EDGE_LABEL_PAD + clearance) / dist);
    });

    unit = Math.ceil(unit / 2) * 2;
  }

  /* ----------------------------------------------------- place the lattice */
  const positions = new Map<string, { x: number; y: number }>();
  const boxes = new Map<string, Box>();
  const index = createIndex(Math.max(unit, 140));

  let minY = Infinity;
  let maxX = -Infinity;

  for (const c of cells) {
    const cx = c.h * unit;
    /* screen Y grows downward, so a larger coordinate sits higher */
    const cyPos = -c.v * unit;
    for (const o of c.offsets) {
      const s = size.get(o.id)!;
      const p = { x: cx + o.dx, y: cyPos + o.dy };
      positions.set(o.id, p);
      boxes.set(o.id, index.insert({ x: p.x, y: p.y, w: s.w, h: s.h }));
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + s.w / 2);
    }
  }

  /* ------------------------------- rooms with no coordinate on this plane */
  const neighbours = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const list = neighbours.get(a) ?? [];
    list.push(b);
    neighbours.set(a, list);
  };
  for (const c of Object.values(graph.connections)) {
    /* the logical pair, so ephemeral links count as neighbours too */
    if (!size.has(c.sourceId) || !size.has(c.targetId)) continue;
    if (c.sourceId === c.targetId) continue;
    link(c.sourceId, c.targetId);
    link(c.targetId, c.sourceId);
  }

  const step = Math.max(36, unit / 2);
  const seedX = (Number.isFinite(maxX) ? maxX : 0) + unit * 1.5;
  let seedY = Number.isFinite(minY) ? minY : 0;
  let seeded = 0;

  /* Rooms reachable from at least one placed (coordinated) room, via any chain
     of other free rooms, get relaxed into place below. Anything left over has
     no connection to the grid at all and is seeded beside it first. */
  const anchored = new Set(cells.length ? [...positions.keys()] : []);
  const freeSet = new Set(freeIds);
  const reachable = new Set<string>();
  {
    const queue = freeIds.filter((id) => (neighbours.get(id) ?? []).some((n) => anchored.has(n)));
    const seen = new Set(queue);
    while (queue.length) {
      const id = queue.shift()!;
      reachable.add(id);
      for (const n of neighbours.get(id) ?? []) {
        if (anchored.has(n) || seen.has(n) || !freeSet.has(n)) continue;
        seen.add(n);
        queue.push(n);
      }
    }
  }

  const isolated = freeIds.filter((id) => !reachable.has(id));
  const connected = freeIds.filter((id) => reachable.has(id));

  /* rooms with no path to the grid: seed them beside it so the relaxation
     below has somewhere to anchor from (their own neighbours follow them). */
  for (const id of isolated) {
    const s = size.get(id)!;
    const spot = findSpot(index, { x: seedX, y: seedY }, s, FREE_MARGIN_X, FREE_MARGIN_Y, step);
    positions.set(id, spot);
    boxes.set(id, index.insert({ x: spot.x, y: spot.y, w: s.w, h: s.h }));
    seedY += (s.h + MARGIN_Y) * 1.2;
    seeded++;
  }

  /* Gauss–Seidel relaxation: each free-but-connected room drifts to the
     centroid of ALL its neighbours (placed rooms and isolated seeds act as
     fixed anchors); this converges to the midpoint for two anchors and to
     even spacing along a chain between them. */
  if (connected.length) {
    const gridCentre = positions.size ? centroid([...positions.values()]) : { x: 0, y: 0 };
    const est = new Map<string, { x: number; y: number }>();
    for (const id of connected) {
      const placedNbrs = (neighbours.get(id) ?? [])
        .filter((n) => positions.has(n))
        .map((n) => positions.get(n)!);
      est.set(id, placedNbrs.length ? centroid(placedNbrs) : { ...gridCentre });
    }

    const posOf = (id: string) => positions.get(id) ?? est.get(id);
    for (let iter = 0; iter < RELAX_ITERATIONS; iter++) {
      for (const id of connected) {
        const nbrs = (neighbours.get(id) ?? [])
          .map(posOf)
          .filter(Boolean) as Array<{ x: number; y: number }>;
        if (nbrs.length) est.set(id, centroid(nbrs));
      }
    }

    for (const id of connected) positions.set(id, est.get(id)!);

    /* settle relaxed rooms out of any collisions, spiralling from their
       relaxed spot rather than snapping back to the grid */
    for (const id of connected) {
      const s = size.get(id)!;
      const spot = findSpot(index, positions.get(id)!, s, FREE_MARGIN_X, FREE_MARGIN_Y, step);
      positions.set(id, spot);
      boxes.set(id, index.insert({ x: spot.x, y: spot.y, w: s.w, h: s.h }));
    }
  }

  const placedByNeighbours = connected.length;

  /* --------------------------------------------- ephemeral stub boxes ---- */
  const stubDist = Math.max(150, unit * 0.8);
  const stubStep = Math.max(24, step * 0.6);

  cy.nodes('.portal')
    .filter((p) => !p.hasClass('ghost'))
    .sort((a, b) => (a.id() < b.id() ? -1 : 1))
    .forEach((p) => {
      const anchorId = p.data('anchorId') as string | undefined;
      const anchor = anchorId ? positions.get(anchorId) : undefined;
      if (!anchor) return;

      const conn = graph.connections[p.data('connectionId') as string];
      const side = (p.data('portalSide') as 'out' | 'in') ?? 'out';
      const storedDx = side === 'out' ? conn?.outDx : conn?.inDx;
      const storedDy = side === 'out' ? conn?.outDy : conn?.inDy;

      let dx: number;
      let dy: number;
      if (storedDx !== null && storedDx !== undefined && storedDy !== null && storedDy !== undefined) {
        dx = storedDx;
        dy = storedDy;
      } else {
        /* no manual offset: lean toward the room on the other side */
        const partnerId = side === 'out' ? conn?.targetId : conn?.sourceId;
        const partner = partnerId ? positions.get(partnerId) : undefined;
        const vx = partner ? partner.x - anchor.x : 0;
        const vy = partner ? partner.y - anchor.y : 0;
        const len = Math.hypot(vx, vy);
        if (len > 1) {
          dx = (vx / len) * stubDist;
          dy = (vy / len) * stubDist;
        } else {
          dx = side === 'out' ? stubDist : -stubDist;
          dy = side === 'out' ? stubDist * 0.45 : -stubDist * 0.45;
        }
      }

      const pb = layoutSpan(p);
      const s = { w: Math.max(pb.w, 40), h: Math.max(pb.h, 24) };
      const spot = findSpot(
        index,
        { x: anchor.x + dx, y: anchor.y + dy },
        s,
        STUB_MARGIN_X,
        STUB_MARGIN_Y,
        stubStep
      );
      positions.set(p.id(), spot);
      index.insert({ x: spot.x, y: spot.y, w: s.w, h: s.h });
    });

  return {
    positions,
    unit,
    placedByCoords: nodes.length - freeIds.length,
    placedByNeighbours,
    seeded
  };
}
