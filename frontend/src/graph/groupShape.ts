/**
 * Rectilinear geometry for the form-fitted grouping styles.
 *
 * Everything here works in model space, on axis-aligned rectangles, and emits
 * hard right angles — never a curve, never a diagonal. Nothing in this file
 * touches Cytoscape, the DOM or a canvas: it is pure geometry, and
 * `groupRegions` is the only thing that feeds it.
 *
 * Padding is never defaulted here. It is a per-grouping property, and a geometry
 * routine that guessed at it would silently disagree with the compound box the
 * user can still drag.
 */
export interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Pt {
  x: number;
  y: number;
}

/** A closed rectilinear ring; the last point is *not* a repeat of the first. */
export type Ring = Pt[];

/** The centreline of a snake loop, plus the thickness of the band drawn along it. */
export interface SnakeLoop {
  centreline: Pt[];
  band: number;
}

/**
 * Past this many rectangles the grid below stops being the cheap option, and a
 * grouping that large reads as a solid blob at any zoom that shows all of it.
 * Such a grouping falls back to its bounding rectangle.
 */
export const MAX_UNION_RECTS = 400;

/** A snake through more boxes than this is an unreadable scribble; fall back too. */
export const MAX_SNAKE_BOXES = 400;

/** Prim is O(n²); past this the corridors are skipped and the union falls back. */
export const MAX_CORRIDOR_UNITS = 300;

/** A band thinner than this is a line, not a band. */
const MIN_BAND = 18;

/** …and so is a corridor, at padding 0. */
const MIN_CORRIDOR = 14;

export const expand = (r: Rect, pad: number): Rect => ({
  x1: r.x1 - pad,
  y1: r.y1 - pad,
  x2: r.x2 + pad,
  y2: r.y2 + pad
});

/**
 * Minkowski sum distributes over union, so expanding each rect of a region by
 * `pad` and re-unioning *is* that region's outward offset. That identity is the
 * whole reason a grouping can offset its sub-grouping's already-unioned rects
 * and get a form-fitted, correctly-spaced nesting at any depth — and the reason
 * a corridor can be stored as a zero-thickness segment and still come out of the
 * union `2 × pad` wide.
 */
export const expandAll = (rects: Rect[], pad: number): Rect[] => rects.map((r) => expand(r, pad));

export function boundsOf(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const r of rects) {
    if (r.x1 < x1) x1 = r.x1;
    if (r.y1 < y1) y1 = r.y1;
    if (r.x2 > x2) x2 = r.x2;
    if (r.y2 > y2) y2 = r.y2;
  }
  return { x1, y1, x2, y2 };
}

export const rectRing = (r: Rect): Ring => [
  { x: r.x1, y: r.y1 },
  { x: r.x2, y: r.y1 },
  { x: r.x2, y: r.y2 },
  { x: r.x1, y: r.y2 }
];

export const inRect = (r: Rect, p: Pt) => p.x >= r.x1 && p.x <= r.x2 && p.y >= r.y1 && p.y <= r.y2;

const centre = (r: Rect): Pt => ({ x: (r.x1 + r.x2) / 2, y: (r.y1 + r.y2) / 2 });

/* ---------------------------------------------------------- the corridors */

/** A thin rect straddling an axis-aligned segment; `half` may be 0. */
function ribbon(a: Pt, b: Pt, half: number): Rect | null {
  if (a.x === b.x && a.y === b.y) return null;
  if (a.y === b.y) {
    return { x1: Math.min(a.x, b.x), x2: Math.max(a.x, b.x), y1: a.y - half, y2: a.y + half };
  }
  return { y1: Math.min(a.y, b.y), y2: Math.max(a.y, b.y), x1: a.x - half, x2: a.x + half };
}

/**
 * One MST edge becomes one corridor: a single straight run if the two units
 * already line up on an axis, otherwise an elbow, turning first along whichever
 * axis it has further to travel (so the corridor leaves the room the way the
 * eye expects it to).
 */
function corridorBetween(a: Rect, b: Rect, half: number): Rect[] {
  const ca = centre(a);
  const cb = centre(b);

  const overlapX = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
  if (overlapX > 0) {
    const x = (Math.max(a.x1, b.x1) + Math.min(a.x2, b.x2)) / 2;
    return [ribbon({ x, y: ca.y }, { x, y: cb.y }, half)].filter(Boolean) as Rect[];
  }
  const overlapY = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  if (overlapY > 0) {
    const y = (Math.max(a.y1, b.y1) + Math.min(a.y2, b.y2)) / 2;
    return [ribbon({ x: ca.x, y }, { x: cb.x, y }, half)].filter(Boolean) as Rect[];
  }

  const elbow =
    Math.abs(cb.x - ca.x) >= Math.abs(cb.y - ca.y) ? { x: cb.x, y: ca.y } : { x: ca.x, y: cb.y };
  return [ribbon(ca, elbow, half), ribbon(elbow, cb, half)].filter(Boolean) as Rect[];
}

/**
 * The corridors that stitch a grouping's units into one contiguous region.
 *
 * A minimum spanning tree over the unit centres, Manhattan metric: the cheapest
 * set of links that leaves nothing isolated, and — being a tree — never draws a
 * corridor it does not need. The result branches wherever the arrangement
 * branches, which is exactly the difference between this and the snake: the
 * snake must be one closed walk, this may be any shape at all.
 *
 * `pad` is the grouping's padding, which the caller will apply to these rects
 * along with everything else. The ribbons are therefore built at the *residual*
 * thickness only — usually zero, because `2 × pad` is already wide enough.
 */
export function connectingCorridors(units: Rect[], pad: number): Rect[] {
  if (units.length < 2 || units.length > MAX_CORRIDOR_UNITS) return [];

  const half = Math.max(0, MIN_CORRIDOR - pad * 2) / 2;
  const centres = units.map(centre);
  const n = units.length;

  /* Prim, O(n²): n is bounded above and the graph is complete, so a heap would
     only add constant factors. */
  const inTree = new Uint8Array(n);
  const best = new Float64Array(n).fill(Infinity);
  const from = new Int32Array(n).fill(-1);
  best[0] = 0;

  const corridors: Rect[] = [];
  for (let k = 0; k < n; k++) {
    let pick = -1;
    for (let i = 0; i < n; i++) if (!inTree[i] && (pick === -1 || best[i] < best[pick])) pick = i;
    inTree[pick] = 1;
    if (from[pick] !== -1) corridors.push(...corridorBetween(units[from[pick]], units[pick], half));

    for (let i = 0; i < n; i++) {
      if (inTree[i]) continue;
      const d = Math.abs(centres[i].x - centres[pick].x) + Math.abs(centres[i].y - centres[pick].y);
      if (d < best[i]) {
        best[i] = d;
        from[i] = pick;
      }
    }
  }
  return corridors;
}

/* ------------------------------------------------------------ the union */

const sortedUnique = (values: number[]): number[] => {
  const out = [...values].sort((a, b) => a - b);
  let n = 0;
  for (let i = 0; i < out.length; i++) {
    if (n === 0 || out[i] !== out[n - 1]) out[n++] = out[i];
  }
  out.length = n;
  return out;
};

/** Index of `v` in an ascending array of the exact coordinates it came from. */
const indexOf = (values: number[], v: number): number => {
  let lo = 0;
  let hi = values.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

/* Screen space is y-down. Walking a ring clockwise on screen keeps the interior
   on the right, which is the convention the tracer relies on: a covered cell
   contributes its top edge running +x, right edge +y, bottom -x, left -y. */
const EAST = 0;
const SOUTH = 1;
const WEST = 2;
const NORTH = 3;

interface Edge {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  dir: number;
  used: boolean;
}

/**
 * The union of a set of axis-aligned rectangles, as closed rectilinear rings.
 *
 * Coordinate-compress both axes, mark the covered cells with a 2-D difference
 * array (O(rects + cells), never O(rects × cells)), emit one directed boundary
 * edge per covered cell side whose neighbour is uncovered, and stitch those into
 * rings. Holes — and a grouping laid out in a ring really does have them — come
 * out as their own rings, wound the other way; the renderer fills with the
 * even-odd rule, so they punch through for free.
 *
 * At a pinch point (two blobs meeting at a single corner) the vertex carries
 * four edges; always taking the sharpest right turn separates them into two
 * rings instead of one self-crossing ring. That matters because the rings are
 * also *stroked*, not merely filled.
 */
export function unionRectilinear(input: Rect[]): Ring[] {
  const rects = input.filter((r) => r.x2 > r.x1 && r.y2 > r.y1);
  if (!rects.length) return [];

  const xs = sortedUnique(rects.flatMap((r) => [r.x1, r.x2]));
  const ys = sortedUnique(rects.flatMap((r) => [r.y1, r.y2]));
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  if (nx <= 0 || ny <= 0) return [];

  const diff = new Int32Array((nx + 1) * (ny + 1));
  const at = (i: number, j: number) => i * (ny + 1) + j;
  for (const r of rects) {
    const i0 = indexOf(xs, r.x1);
    const i1 = indexOf(xs, r.x2);
    const j0 = indexOf(ys, r.y1);
    const j1 = indexOf(ys, r.y2);
    diff[at(i0, j0)]++;
    diff[at(i1, j0)]--;
    diff[at(i0, j1)]--;
    diff[at(i1, j1)]++;
  }

  const covered = new Uint8Array(nx * ny);
  const cell = (i: number, j: number) => i * ny + j;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const up = i > 0 ? diff[at(i - 1, j)] : 0;
      const left = j > 0 ? diff[at(i, j - 1)] : 0;
      const diag = i > 0 && j > 0 ? diff[at(i - 1, j - 1)] : 0;
      diff[at(i, j)] += up + left - diag;
      if (diff[at(i, j)] > 0) covered[cell(i, j)] = 1;
    }
  }
  const isCovered = (i: number, j: number) =>
    i >= 0 && j >= 0 && i < nx && j < ny && covered[cell(i, j)] === 1;

  const edges: Edge[] = [];
  const outgoing = new Map<number, number[]>();
  const key = (x: number, y: number) => x * (ny + 1) + y;
  const push = (ax: number, ay: number, bx: number, by: number, dir: number) => {
    const index = edges.length;
    edges.push({ ax, ay, bx, by, dir, used: false });
    const k = key(ax, ay);
    const list = outgoing.get(k);
    if (list) list.push(index);
    else outgoing.set(k, [index]);
  };

  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      if (!isCovered(i, j)) continue;
      if (!isCovered(i, j - 1)) push(i, j, i + 1, j, EAST);
      if (!isCovered(i + 1, j)) push(i + 1, j, i + 1, j + 1, SOUTH);
      if (!isCovered(i, j + 1)) push(i + 1, j + 1, i, j + 1, WEST);
      if (!isCovered(i - 1, j)) push(i, j + 1, i, j, NORTH);
    }
  }

  /* sharpest right turn first, then straight, then left, then back */
  const PREFERENCE = [1, 0, 3, 2];

  const rings: Ring[] = [];
  for (let start = 0; start < edges.length; start++) {
    if (edges[start].used) continue;

    const raw: Pt[] = [];
    let e: Edge | null = edges[start];
    while (e && !e.used) {
      e.used = true;
      raw.push({ x: xs[e.ax], y: ys[e.ay] });

      const candidates: number[] = outgoing.get(key(e.bx, e.by)) ?? [];
      const fromDir: number = e.dir;
      let next: Edge | null = null;
      for (const turn of PREFERENCE) {
        const want: number = (fromDir + turn) & 3;
        const found: number | undefined = candidates.find(
          (idx: number) => !edges[idx].used && edges[idx].dir === want
        );
        if (found !== undefined) {
          next = edges[found];
          break;
        }
      }
      e = next;
    }
    const ring = mergeCollinear(raw);
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

/** Drop the mid-point of every straight run; a ring only needs its corners. */
function mergeCollinear(ring: Pt[]): Ring {
  const n = ring.length;
  if (n < 3) return ring;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const prev = ring[(i - 1 + n) % n];
    const cur = ring[i];
    const next = ring[(i + 1) % n];
    const straight =
      (prev.x === cur.x && cur.x === next.x) || (prev.y === cur.y && cur.y === next.y);
    if (!straight) out.push(cur);
  }
  return out;
}

export interface FormFit {
  rings: Ring[];
  /** The filled area, as rectangles — what the hit test and the fallback use. */
  rects: Rect[];
}

/** The form-fitted body of a grouping, or its bounding rectangle if it is huge. */
export function formFit(rects: Rect[]): FormFit {
  if (!rects.length) return { rings: [], rects: [] };
  if (rects.length > MAX_UNION_RECTS) {
    const b = boundsOf(rects)!;
    /* the hit area has to be what was *drawn*, not what it was drawn from */
    return { rings: [rectRing(b)], rects: [b] };
  }
  return { rings: unionRectilinear(rects), rects };
}

/* --------------------------------------------------- the title's geometry */

/** The top-most horizontal extent of a region: where a title belongs. */
export interface TopEdge {
  x1: number;
  x2: number;
  y: number;
}

/**
 * Every rectangle whose top edge lies on the region's highest line contributes
 * its span; the title is centred on the union of those spans.
 *
 * For a rectangle body that union is the whole top edge, so this reduces to
 * today's placement. For a U-shaped outline the two arms both reach the top and
 * the title centres between them — which is right, because the title is drawn
 * *above* the edge either way, over the canvas, exactly as a rectangle's always
 * has been. (If you'd rather it centred on the single widest top run, take the
 * max-width span instead of the union here; it is the only line that changes.)
 */
export function topEdgeOf(rects: Rect[]): TopEdge | null {
  if (!rects.length) return null;
  let y = Infinity;
  for (const r of rects) if (r.y1 < y) y = r.y1;

  let x1 = Infinity;
  let x2 = -Infinity;
  for (const r of rects) {
    if (r.y1 > y + 0.5) continue;
    if (r.x1 < x1) x1 = r.x1;
    if (r.x2 > x2) x2 = r.x2;
  }
  return Number.isFinite(x1) ? { x1, x2, y } : null;
}

/** The band of a snake loop, as rectangles — one per centreline segment. This is
 *  what lets the loop share the outline's hit test and top-edge logic. */
export function bandRects(loop: SnakeLoop): Rect[] {
  const half = loop.band / 2;
  const pts = loop.centreline;
  const out: Rect[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    out.push({
      x1: Math.min(a.x, b.x) - half,
      x2: Math.max(a.x, b.x) + half,
      y1: Math.min(a.y, b.y) - half,
      y2: Math.max(a.y, b.y) + half
    });
  }
  return out;
}

/* ------------------------------------------------------------ the snake */

const centreY = (r: Rect) => (r.y1 + r.y2) / 2;

/**
 * A closed orthogonal tour through every box — a boustrophedon, which is
 * literally a snake.
 *
 * Rows are the transitive vertical-overlap classes of the boxes, so the banding
 * comes from the arrangement itself rather than from a magic row height. Each
 * row contributes one horizontal run along its spine, wide enough to span every
 * box in it; consecutive rows are joined by a vertical run placed clear of both
 * rows' outermost box. The tour is closed by a return leg routed *outside* the
 * bounding box, which is the only way to guarantee it cannot cross a row.
 *
 * The band is thick enough to cover the tallest box, but never thicker than the
 * tightest gap between two spines — two rows that nearly touch would otherwise
 * merge into one blob. Where the clamp bites, the boxes poke out of their band;
 * they are drawn over it anyway, so it reads as the band hugging them.
 */
export function snakeLoop(boxes: Rect[], pad: number): SnakeLoop | null {
  if (!boxes.length || boxes.length > MAX_SNAKE_BOXES) return null;

  const sorted = [...boxes].sort((a, b) => centreY(a) - centreY(b) || a.x1 - b.x1);

  const rows: Rect[][] = [];
  let current: Rect[] = [];
  let bottom = -Infinity;
  for (const b of sorted) {
    if (!current.length || b.y1 < bottom) {
      current.push(b);
      bottom = Math.max(bottom, b.y2);
    } else {
      rows.push(current);
      current = [b];
      bottom = b.y2;
    }
  }
  if (current.length) rows.push(current);

  const spine = rows.map((row) => row.reduce((s, b) => s + centreY(b), 0) / row.length);
  const left = rows.map((row) => Math.min(...row.map((b) => b.x1)) - pad);
  const right = rows.map((row) => Math.max(...row.map((b) => b.x2)) + pad);

  const tallest = Math.max(...boxes.map((b) => b.y2 - b.y1));
  let band = tallest + pad * 2;
  for (let i = 0; i + 1 < rows.length; i++) {
    band = Math.min(band, (spine[i + 1] - spine[i]) * 0.9);
  }
  band = Math.max(MIN_BAND, band);

  /** +1 = this row runs left-to-right. */
  const dir = (i: number) => (i % 2 === 0 ? 1 : -1);
  /** The vertical run down to the next row, placed clear of both rows. */
  const connector = (i: number) =>
    dir(i) > 0 ? Math.max(right[i], right[i + 1]) : Math.min(left[i], left[i + 1]);

  const last = rows.length - 1;
  const pts: Pt[] = [];
  let entry = left[0]; // row 0 always runs rightwards, so it is entered at its left
  for (let i = 0; i <= last; i++) {
    const exit = i < last ? connector(i) : dir(i) > 0 ? right[i] : left[i];
    pts.push({ x: entry, y: spine[i] }, { x: exit, y: spine[i] });
    entry = exit;
  }

  const b = boundsOf(boxes)!;
  const ring = band * 1.5 + pad;
  const outerLeft = b.x1 - ring;
  const outerRight = b.x2 + ring;
  const outerTop = b.y1 - ring;
  const first = pts[0];
  const tail = pts[pts.length - 1];

  if (dir(last) > 0) {
    /* the tour ends on the right: out right, over the top, down the left side */
    pts.push(
      { x: outerRight, y: tail.y },
      { x: outerRight, y: outerTop },
      { x: outerLeft, y: outerTop },
      { x: outerLeft, y: first.y }
    );
  } else {
    /* the tour ends on the left: straight up the left side */
    pts.push({ x: outerLeft, y: tail.y }, { x: outerLeft, y: first.y });
  }

  /* a zero-length segment would leave a stray miter join; collinear points are
     *kept*, because a U-turn is collinear and dropping its apex would cut the
     corner clean off the band */
  const centreline: Pt[] = [];
  for (const p of pts) {
    const prev = centreline[centreline.length - 1];
    if (!prev || prev.x !== p.x || prev.y !== p.y) centreline.push(p);
  }
  if (centreline.length < 2) return null;

  return { centreline, band };
}
