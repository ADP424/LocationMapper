import type { Collection, Core, EdgeSingular, NodeSingular } from 'cytoscape';
import type { Settings } from '../state/settings';
import { DrawBudget } from './frameMeter';
import { BoxGrid, type Rect } from './spatialIndex';
import {
  EMPTY_BUDGET,
  FONT_MIN,
  GROUP_NAME_INSET,
  GROUP_NAME_MAX_PX,
  GROUP_NAME_MIN_PX,
  IDENTITY_SCALE,
  OVERSIZE_TOLERANCE,
  scaleKey,
  solveViewScale,
  type ScaleLimit,
  type ViewBudget,
  type ViewScale
} from './viewScale';

/** A grouping's skeleton title font, at text factor 1 (mirrors `style.ts`'s
 *  `node.group` base `font-size: 15 * tv`). */
const GROUP_FONT = 15;

/** Extra viewport fractions kept written, so a flick of the pan finds fresh data. */
const PAD = 0.35;
/** A `min-zoomed-font-size` no font can ever reach. */
const LABELS_OFF = 1e6;

const KIND_LOCATION = 0;
const KIND_PORTAL = 1;
const KIND_GROUP = 2;
const KIND_OTHER = 3;
const MIN_BY_KIND = [FONT_MIN.location, FONT_MIN.portal, FONT_MIN.group, FONT_MIN.location];

/** The N largest values seen, without sorting everything. */
class TopK {
  private readonly a: Float64Array;
  private n = 0;
  constructor(private readonly k: number) {
    this.a = new Float64Array(k); // ascending; a[0] is the current k-th largest
  }
  reset() {
    this.n = 0;
  }
  add(v: number) {
    if (v <= 0) return;
    if (this.n < this.k) {
      let i = this.n++;
      while (i > 0 && this.a[i - 1] > v) {
        this.a[i] = this.a[i - 1];
        i--;
      }
      this.a[i] = v;
      return;
    }
    if (v <= this.a[0]) return;
    let i = 0;
    while (i + 1 < this.k && this.a[i + 1] < v) {
      this.a[i] = this.a[i + 1];
      i++;
    }
    this.a[i] = v;
  }
  /** 0 while fewer than `k` items exist — i.e. "tolerate them all". */
  get ceiling() {
    return this.n < this.k ? 0 : this.a[0];
  }
}

/**
 * Owns every zoom-dependent style write — and since boxes never scale at
 * runtime, that is exactly two data keys per element: `tView` (the text
 * scalar) and `minFontView` (name visibility). No geometry is ever
 * invalidated, no edge is ever re-routed, no compound parent is re-measured.
 *
 *  * A bucket grid is built over each element's *footprint* (box or name
 *    plate, whichever is bigger — see `layoutSpan`), rebuilt when elements
 *    move, not when the view does, so a pass visits O(visible) elements.
 *  * With compensation off, the identity scale is what `buildElements` already
 *    baked into every row, so a pan or a zoom writes nothing at all.
 *  * The pass is rate-limited by *its own measured duration*, not by a
 *    formula on element count.
 */
export class ViewScaler {
  private settings: Settings;
  private scale: ViewScale = IDENTITY_SCALE;
  private key = scaleKey(IDENTITY_SCALE);
  /** Serial 0 is the identity scale, which `buildElements` bakes into new rows. */
  private serials = new Map<string, number>([[this.key, 0]]);
  private serial = 0;
  private nextSerial = 0;

  private readonly drawBudget = new DrawBudget();
  private readonly budget: ViewBudget = { ...EMPTY_BUDGET };
  private readonly topLabel = new TopK(OVERSIZE_TOLERANCE);

  private nodes: NodeSingular[] = [];
  private edges: EdgeSingular[] = [];
  private nodeKind = new Uint8Array(0);
  private nodeScalar = new Float64Array(0);
  private nodeLabelW = new Float64Array(0);
  private nodeGen = new Int32Array(0);
  private edgeLabelW = new Float64Array(0);
  private edgeGen = new Int32Array(0);

  private nodeGrid = new BoxGrid();
  private edgeGrid = new BoxGrid();
  private visN = new Int32Array(0);
  private visE = new Int32Array(0);
  private visNCount = 0;
  private visECount = 0;
  /** Half the widest name plate, model units — how far a name can poke into view. */
  private maxLabelHalf = 0;

  private locked = false;
  private frame = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastRun = 0;
  private lastCost = 1;
  private onLimitChange?: (limit: ScaleLimit, budget: ViewBudget) => void;

  constructor(
    private readonly cy: Core,
    settings: Settings,
    onLimitChange?: (limit: ScaleLimit, budget: ViewBudget) => void
  ) {
    this.settings = settings;
    this.onLimitChange = onLimitChange;
    cy.on('render', this.onRender);
    cy.on('viewport', this.request);
  }

  destroy() {
    this.cy.off('render', this.onRender);
    this.cy.off('viewport', this.request);
    if (this.frame) cancelAnimationFrame(this.frame);
    if (this.timer) clearTimeout(this.timer);
  }

  private onRender = () => this.drawBudget.sample(performance.now());

  get currentScale() {
    return this.scale;
  }
  get frameMs() {
    return this.drawBudget.frameMs;
  }

  /** Record the new settings. Re-solving is the canvas's `syncGeometry` job,
   *  so one settings change never runs the pass twice. */
  setSettings(next: Settings) {
    this.settings = next;
  }

  /** Structural change: re-read every element. Positions are read too. */
  build() {
    const cy = this.cy;
    this.nodes = cy.nodes().toArray() as NodeSingular[];
    this.edges = cy.edges().toArray() as EdgeSingular[];
    const n = this.nodes.length;
    const m = this.edges.length;

    this.nodeKind = new Uint8Array(n);
    this.nodeScalar = new Float64Array(n);
    this.nodeLabelW = new Float64Array(n);
    this.nodeGen = new Int32Array(n).fill(-1);
    this.visN = new Int32Array(n);
    this.edgeLabelW = new Float64Array(m);
    this.edgeGen = new Int32Array(m).fill(-1);
    this.visE = new Int32Array(m);

    for (let i = 0; i < n; i++) {
      const node = this.nodes[i];
      const d = node.data();
      const kind =
        d.kind === 'group'
          ? KIND_GROUP
          : d.portalSide !== undefined
            ? KIND_PORTAL
            : d.kind === 'location'
              ? KIND_LOCATION
              : KIND_OTHER;
      this.nodeKind[i] = kind;
      this.nodeScalar[i] =
        kind === KIND_LOCATION && typeof d.size === 'number' && d.size > 0 ? d.size : 1;
      const lw = typeof d.lw === 'number' ? d.lw : typeof d.labelWidth === 'number' ? d.labelWidth : 0;
      this.nodeLabelW[i] = lw;
    }
    for (let j = 0; j < m; j++) {
      const lw = this.edges[j].data('labelWidth');
      this.edgeLabelW[j] = typeof lw === 'number' ? lw : 0;
    }
    this.reposition();
  }

  /** Positions changed (drag, layout): rebuild the buckets only.
   *  Deliberately does **not** flush: `syncGeometry` owns the single pass, and
   *  it has to run after the stacking pass and after the zoom has settled. */
  reposition() {
    const n = this.nodes.length;
    const boxes = new Float64Array(n * 4);
    const always: number[] = [];
    let maxPlate = 0;
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      if (this.nodeKind[i] === KIND_GROUP || this.nodeKind[i] === KIND_OTHER) {
        always.push(i); // groupings derive their box from children; ghosts are few
        continue;
      }
      maxPlate = Math.max(maxPlate, this.nodeLabelW[i]);
      const node = this.nodes[i];
      const p = node.position();
      /* the footprint (box or name plate, whichever is bigger) — a name can be
         the wider extent under a large Base Size, and stays visible past its
         room's own edge */
      const sw = node.data('spanW');
      const sh = node.data('spanH');
      const hw = ((typeof sw === 'number' && sw > 0 ? sw : node.data('w')) || 0) / 2;
      const hh = ((typeof sh === 'number' && sh > 0 ? sh : node.data('h')) || 0) / 2;
      boxes[o] = p.x - hw;
      boxes[o + 1] = p.y - hh;
      boxes[o + 2] = p.x + hw;
      boxes[o + 3] = p.y + hh;
    }
    this.maxLabelHalf = maxPlate / 2;
    this.nodeGrid.build(boxes, n, always);

    const m = this.edges.length;
    const ebox = new Float64Array(m * 4);
    for (let j = 0, o = 0; j < m; j++, o += 4) {
      const s = this.edges[j].source().position();
      const t = this.edges[j].target().position();
      ebox[o] = Math.min(s.x, t.x);
      ebox[o + 1] = Math.min(s.y, t.y);
      ebox[o + 2] = Math.max(s.x, t.x);
      ebox[o + 3] = Math.max(s.y, t.y);
    }
    /* a screen-crossing edge has both endpoints off-screen; the grid's own
       "too large to bucket" rule catches exactly those and always visits them */
    this.edgeGrid.build(ebox, m);
  }

  /** A handful of elements whose own data changed. */
  markDirty(ids: Iterable<string>) {
    for (const id of ids) {
      const node = this.cy.getElementById(id);
      if (node.empty()) continue;
      const i = this.nodes.indexOf(node[0] as NodeSingular);
      if (i >= 0) this.nodeGen[i] = -1;
      else {
        const j = this.edges.indexOf(node[0] as EdgeSingular);
        if (j >= 0) this.edgeGen[j] = -1;
      }
    }
  }

  /** Transient elements (ghosts, reconnect handles) added outside the reconcile.
   *  Their box/line geometry is already static in their own data; only the two
   *  text keys need seeding. */
  applyTo(eles: Collection) {
    const { text, labels } = this.scale;
    const base = Math.max(0.05, this.settings.baseScale);
    this.cy.batch(() => {
      eles.forEach((ele) => {
        ele.data({
          tView: base * text,
          minFontView: labels ? FONT_MIN.location : LABELS_OFF
        });
      });
    });
  }

  /** Layout engines measure labels (`nodeDimensionsIncludeLabels`), and a
   *  label's model size is `raw × tView`: the arrangement must see Base-Size
   *  names, never compensated ones, or every re-layout at a different zoom
   *  would drift. */
  lockForLayout(): () => void {
    const previous = this.scale;
    this.locked = false;
    this.applyScale(IDENTITY_SCALE, true);
    this.locked = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.locked = false;
      this.applyScale(previous, true);
      this.flush(true);
    };
  }

  request = () => {
    if (this.locked || this.frame || this.timer) return;
    const interval = Math.min(120, Math.max(8, this.lastCost * 3));
    const wait = Math.max(0, interval - (performance.now() - this.lastRun));
    if (!wait) {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.run(false);
      });
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.run(false);
      });
    }, wait);
  };

  flush(force = false) {
    if (this.frame) cancelAnimationFrame(this.frame);
    if (this.timer) clearTimeout(this.timer);
    this.frame = 0;
    this.timer = null;
    this.run(force);
  }

  /* ───────────────────────────────────────────────────────────── internals */

  private applyScale(next: ViewScale, writeEverything: boolean) {
    this.scale = next;
    const key = scaleKey(next);
    if (key !== this.key) {
      this.key = key;
      let serial = this.serials.get(key);
      if (serial === undefined) {
        serial = ++this.nextSerial;
        this.serials.set(key, serial);
      }
      this.serial = serial;
    }
    if (writeEverything) {
      this.cy.batch(() => {
        for (let i = 0; i < this.nodes.length; i++) this.writeNode(i);
        for (let j = 0; j < this.edges.length; j++) this.writeEdge(j);
      });
    }
  }

  private run(force: boolean) {
    if (this.locked) return;
    const t0 = performance.now();
    this.lastRun = t0;

    const ext = this.cy.extent();
    /* a compensated name plate can poke into view from well outside its own
       element's box, so the query is widened by the largest half-plate */
    const labelPad = this.maxLabelHalf * this.scale.text;
    const near: Rect = {
      x1: ext.x1 - ext.w * PAD - labelPad,
      x2: ext.x2 + ext.w * PAD + labelPad,
      y1: ext.y1 - ext.h * PAD - labelPad,
      y2: ext.y2 + ext.h * PAD + labelPad
    };
    const stale = this.gather(ext, near);

    const next = solveViewScale(this.cy.zoom(), this.settings, this.budget);
    const moved = scaleKey(next) !== this.key;
    const limitChanged = next.limit !== this.scale.limit;
    if (moved) this.applyScale(next, false);
    else this.scale = next;

    if (!force && !moved && !stale) {
      if (limitChanged) this.onLimitChange?.(next.limit, this.budget);
      return;
    }

    this.cy.batch(() => {
      for (let k = 0; k < this.visNCount; k++) {
        const i = this.visN[k];
        if (this.nodeGen[i] !== this.serial) this.writeNode(i);
      }
      for (let k = 0; k < this.visECount; k++) {
        const j = this.visE[k];
        if (this.edgeGen[j] !== this.serial) this.writeEdge(j);
      }
    });

    this.lastCost = Math.max(0.5, performance.now() - t0);
    if (limitChanged) this.onLimitChange?.(next.limit, this.budget);
  }

  /** One grid query: the write set, the label budget and whether anything is stale. */
  private gather(ext: Rect, near: Rect): boolean {
    const b = this.budget;
    b.labelled = 0;
    b.budget = this.drawBudget.elements;
    this.topLabel.reset();
    this.visNCount = 0;
    this.visECount = 0;
    let stale = false;

    this.nodeGrid.forEach(near, (i) => {
      this.visN[this.visNCount++] = i;
      if (this.nodeGen[i] !== this.serial) stale = true;
      const p = this.nodes[i].position();
      if (p.x < ext.x1 || p.x > ext.x2 || p.y < ext.y1 || p.y > ext.y2) return;
      if (this.nodeLabelW[i] > 0) {
        b.labelled++;
        this.topLabel.add(this.nodeLabelW[i]);
      }
    });

    this.edgeGrid.forEach(near, (j) => {
      this.visE[this.visECount++] = j;
      if (this.edgeGen[j] !== this.serial) stale = true;
      if (this.edgeLabelW[j] > 0) {
        b.labelled++;
        this.topLabel.add(this.edgeLabelW[j]);
      }
    });

    b.labelCeiling = this.topLabel.ceiling;
    return stale;
  }

  /** The only thing a zoom gesture ever touches: two or three keys, no geometry. */
  private writeNode(i: number) {
    if (this.nodeKind[i] === KIND_GROUP) return this.writeGroup(i);
    const { text, labels, skeleton } = this.scale;
    const base = Math.max(0.05, this.settings.baseScale);
    const kind = this.nodeKind[i];
    this.nodes[i].data({
      tView: this.nodeScalar[i] * base * text,
      minFontView: labels ? MIN_BY_KIND[kind] : LABELS_OFF,
      /* the skeleton hides the box itself (style.ts reads this, not a class,
         so the flip is one data write per element, no selector re-match) */
      skel: skeleton ? 1 : 0
    });
    this.nodeGen[i] = this.serial;
  }

  /**
   * In the skeleton, a grouping is the only thing left with area, so its
   * title is fitted to *its own box*. `titleW`/`titleH` are the raw text
   * metrics at the base font, so the drawn title is exactly `title × tView`:
   * solving `tView` from the box therefore gives the title precisely the
   * width and height it needs, no more and no less, with `GROUP_NAME_INSET`
   * of breathing room per side. Base Size genuinely cancels out. Nested
   * groupings reveal their names as you zoom in — a level-of-detail cascade
   * that falls out of the fit for free.
   */
  private writeGroup(i: number) {
    const node = this.nodes[i];
    const { text, labels, skeleton } = this.scale;
    const base = Math.max(0.05, this.settings.baseScale);

    let tView = base * text;
    let minFontView = labels ? FONT_MIN.group : LABELS_OFF;

    if (skeleton) {
      const titleW = (node.data('titleW') as number) || 0;
      const titleH = (node.data('titleH') as number) || 0;
      const boxW = (node.data('boxW') as number) || 0;
      const boxH = (node.data('boxH') as number) || 0;

      if (titleW > 0 && titleH > 0 && boxW > 0 && boxH > 0) {
        /* a ratio of two model-unit quantities, so it is the same at every
           zoom: the box shrinks right along with the title */
        const availW = boxW * (1 - 2 * GROUP_NAME_INSET);
        const availH = boxH * (1 - 2 * GROUP_NAME_INSET);
        let t = Math.min(availW / titleW, availH / titleH);

        const rendered = GROUP_FONT * t * this.cy.zoom();
        if (rendered > GROUP_NAME_MAX_PX) t *= GROUP_NAME_MAX_PX / rendered;

        tView = t;
        /* Cytoscape culls it for us once the fitted title is too small to
           read — which happens exactly when the box itself has shrunk past
           legibility, the correct moment for its title to go with it */
        minFontView = GROUP_NAME_MIN_PX;
      } else {
        minFontView = LABELS_OFF;
      }
    }

    if (node.hasClass('skel') !== skeleton) node.toggleClass('skel', skeleton);
    node.data({ tView, minFontView, skel: skeleton ? 1 : 0 });
    this.nodeGen[i] = this.serial;
  }

  private writeEdge(j: number) {
    const { text, labels, skeleton, lines, line } = this.scale;
    const base = Math.max(0.05, this.settings.baseScale);
    this.edges[j].data({
      tView: base * text,
      minFontView: labels ? FONT_MIN.edge : LABELS_OFF,
      lineView: skeleton ? line : 1,
      /* a line-less skeleton takes the connections out of drawing *and* hit
         testing entirely — see `display` in style.ts */
      edgeHidden: lines ? 0 : 1
    });
    this.edgeGen[j] = this.serial;
  }
}
