export interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Boxes covering more cells than this are never bucketed — they are always visited. */
const MAX_SPAN_CELLS = 48;
const MAX_CELLS = 1 << 18;

/**
 * Uniform bucket grid over axis-aligned boxes. Build is one O(n) counting sort
 * into CSR arrays; a query is O(cells touched + hits) with no allocation.
 *
 * It is deliberately an *over*-approximation: `forEach` yields every item whose
 * cell overlaps the rectangle, so callers that need exactness must test again.
 * For "which elements must be restyled" an over-approximation is exactly right.
 */
export class BoxGrid {
  private cell = 1;
  private cols = 0;
  private rows = 0;
  private ox = 0;
  private oy = 0;
  private bx = 0;
  private by = 0;
  private starts = new Int32Array(1);
  private items = new Int32Array(0);
  private stamp = new Int32Array(0);
  private gen = 0;
  private count = 0;
  /** Items too large to bucket (grouping boxes, screen-crossing edges). */
  private always: number[] = [];

  get size() {
    return this.count;
  }

  /**
   * `boxes` is flat `[x1,y1,x2,y2, …]`. Items with a zero-area box are fine.
   *
   * `always` are indices the caller has already decided must always be
   * visited (e.g. a compound node whose box is derived from its children, not
   * from `boxes`). Those indices are excluded from cell bucketing entirely —
   * otherwise a zero/degenerate box for one would still land in exactly one
   * cell and get visited *again* from there, which would silently overflow a
   * caller's fixed-size output buffer sized to exactly `n` visits.
   */
  build(boxes: Float64Array, n: number, always: number[] = []) {
    this.count = n;
    this.always = always;
    this.gen = 0;
    if (this.stamp.length < n) this.stamp = new Int32Array(Math.max(n, 64));
    else this.stamp.fill(0, 0, n);

    if (!n) {
      this.cols = this.rows = 0;
      this.starts = new Int32Array(1);
      this.items = new Int32Array(0);
      return;
    }

    const excluded = new Uint8Array(n);
    for (let k = 0; k < always.length; k++) excluded[always[k]] = 1;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let span = 0;
    let counted = 0;
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      if (excluded[i]) continue;
      if (boxes[o] < minX) minX = boxes[o];
      if (boxes[o + 1] < minY) minY = boxes[o + 1];
      if (boxes[o + 2] > maxX) maxX = boxes[o + 2];
      if (boxes[o + 3] > maxY) maxY = boxes[o + 3];
      span += boxes[o + 2] - boxes[o] + (boxes[o + 3] - boxes[o + 1]);
      counted++;
    }
    if (!counted) {
      // everything was excluded (always-only): no cell grid to build
      this.cols = this.rows = 0;
      this.starts = new Int32Array(1);
      this.items = new Int32Array(0);
      return;
    }
    const w = Math.max(1e-6, maxX - minX);
    const h = Math.max(1e-6, maxY - minY);
    const meanSpan = Math.max(1e-6, span / (2 * counted));

    /* ~4 items per cell, but never finer than the mean box (that only multiplies
       the duplicate-visit work without narrowing anything) */
    let cell = Math.max(meanSpan, Math.sqrt((w * h * 4) / n));
    let cols = Math.ceil(w / cell) + 1;
    let rows = Math.ceil(h / cell) + 1;
    while (cols * rows > MAX_CELLS) {
      cell *= 2;
      cols = Math.ceil(w / cell) + 1;
      rows = Math.ceil(h / cell) + 1;
    }
    this.cell = cell;
    this.cols = cols;
    this.rows = rows;
    this.ox = minX;
    this.oy = minY;
    this.bx = maxX;
    this.by = maxY;

    const cells = cols * rows;
    const counts = new Int32Array(cells + 1);
    const spans = (o: number) => {
      const c0 = this.col(boxes[o]);
      const c1 = this.col(boxes[o + 2]);
      const r0 = this.row(boxes[o + 1]);
      const r1 = this.row(boxes[o + 3]);
      return { c0, c1, r0, r1, n: (c1 - c0 + 1) * (r1 - r0 + 1) };
    };

    for (let i = 0, o = 0; i < n; i++, o += 4) {
      if (excluded[i]) continue;
      const s = spans(o);
      if (s.n > MAX_SPAN_CELLS) {
        this.always.push(i);
        continue;
      }
      for (let c = s.c0; c <= s.c1; c++) {
        for (let r = s.r0; r <= s.r1; r++) counts[c * rows + r + 1]++;
      }
    }
    for (let i = 0; i < cells; i++) counts[i + 1] += counts[i];
    this.starts = counts;
    this.items = new Int32Array(counts[cells]);
    const cursor = Int32Array.from(counts.subarray(0, cells));
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      if (excluded[i]) continue;
      const s = spans(o);
      if (s.n > MAX_SPAN_CELLS) continue;
      for (let c = s.c0; c <= s.c1; c++) {
        for (let r = s.r0; r <= s.r1; r++) this.items[cursor[c * rows + r]++] = i;
      }
    }
  }

  private col(x: number) {
    const c = ((x - this.ox) / this.cell) | 0;
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
  }
  private row(y: number) {
    const r = ((y - this.oy) / this.cell) | 0;
    return r < 0 ? 0 : r >= this.rows ? this.rows - 1 : r;
  }

  forEach(rect: Rect, fn: (i: number) => void) {
    for (let i = 0; i < this.always.length; i++) fn(this.always[i]);
    if (!this.count || !this.cols) return;
    if (rect.x2 < this.ox || rect.x1 > this.bx || rect.y2 < this.oy || rect.y1 > this.by) return;

    if (++this.gen === 0x7fffffff) {
      this.stamp.fill(0);
      this.gen = 1;
    }
    const g = this.gen;
    const c0 = this.col(rect.x1);
    const c1 = this.col(rect.x2);
    const r0 = this.row(rect.y1);
    const r1 = this.row(rect.y2);
    for (let c = c0; c <= c1; c++) {
      const base = c * this.rows;
      for (let r = r0; r <= r1; r++) {
        const cell = base + r;
        for (let k = this.starts[cell], end = this.starts[cell + 1]; k < end; k++) {
          const i = this.items[k];
          if (this.stamp[i] === g) continue;
          this.stamp[i] = g;
          fn(i);
        }
      }
    }
  }
}
