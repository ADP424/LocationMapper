import type { Core, EdgeSingular, NodeSingular } from 'cytoscape';
import type { Settings } from '../state/settings';

/**
 * The *base* (un-zoomed, un-clamped) box of a node: the text box — shape metrics
 * and all — times the location's size scalar, times the global base size. Layouts,
 * the coordinate grid, the stacking areas and the extent model must all measure
 * with this, never with `node.width()`, which is drawn geometry.
 */
export function baseSize(node: NodeSingular) {
  const w = node.data('w');
  const h = node.data('h');
  return {
    w: typeof w === 'number' && w > 0 ? w : node.width(),
    h: typeof h === 'number' && h > 0 ? h : node.height()
  };
}

export const MAX_COMPENSATED_ELEMENTS = 8_000;

export function compensationInterval(elementCount: number) {
  return Math.min(250, Math.max(16, Math.round(elementCount / 12)));
}

export function viewScaleFactor(zoom: number, settings: Settings): number {
  if (!settings.constantSize || settings.sizeCompensation <= 0) return 1;
  const strength = Math.min(1, Math.max(0, settings.sizeCompensation));
  const z = Math.min(8, Math.max(0.01, zoom));
  return Math.pow(z, -strength);
}

/* ------------------------------------------------------- render ceilings */

/**
 * Cytoscape renders elements and labels into 1024×1024 texture atlases and
 * re-renders anything larger from scratch on *every frame*; Chrome also stops
 * caching glyph rasters around 256 px and starts filling outlines. So nothing is
 * ever drawn bigger than this, whatever the size settings say. Slack is left for
 * borders and overlays, which the element's bounding box also includes.
 */
const MAX_RENDERED_BOX = 900;
const MAX_RENDERED_LABEL = 960;

export interface GeometryBudget {
  /** Largest drawn node box, base units — shape metrics and both scalars included. */
  maxBox: number;
  /** Longest *un-wrapped* label (connection and grouping names), base units. */
  maxLabel: number;
}

export const EMPTY_BUDGET: GeometryBudget = { maxBox: 0, maxLabel: 0 };

export interface RenderRatios {
  /** Applied to every size-like property, so relative sizing is exact. */
  box: number;
  /** Applied to the labels no box contains. */
  text: number;
}

/** ~2 % steps, always rounding *down*, so a ceiling is never exceeded. */
const quantise = (r: number) => (r >= 1 ? 1 : Math.pow(2, Math.floor(Math.log2(r) * 32) / 32));

/**
 * One ratio for the whole graph, so a size-5 room that hits the ceiling leaves a
 * size-1 room at exactly a fifth of it — and a star, which is `2.7×` its text box,
 * hits the ceiling before a rectangle with the same label does.
 *
 * A node's label is strictly inside its box (`w = textW·wFactor + padX`, with
 * `wFactor ≥ 1`), so bounding the box bounds the label texture too. Connection and
 * grouping names are inside nothing, hence the second ratio.
 */
export function renderRatios(zoom: number, f: number, budget: GeometryBudget): RenderRatios {
  const scale = Math.max(1e-9, f * zoom); // base units -> rendered px
  const box = budget.maxBox * scale;
  const label = budget.maxLabel * scale;

  const r = box > MAX_RENDERED_BOX ? quantise(MAX_RENDERED_BOX / box) : 1;
  const t = label > 0 ? Math.min(r, quantise(MAX_RENDERED_LABEL / label)) : r;
  return { box: r, text: t };
}

/* --------------------------------------------------------------- the pass */

const VIEWPORT_PAD = 0.5;
const GENERATION = '_mgScale';

const FONT = { location: 12, portal: 10, group: 15, edge: 11 };
const MIN_FONT = { location: 6, portal: 6, group: 5, edge: 7 };

const sizeOf = (data: Record<string, unknown>) => {
  const s = data.size;
  return typeof s === 'number' && s > 0 ? s : 1;
};

const generations = new WeakMap<Core, { key: string; gen: number }>();
function generationFor(cy: Core, key: string) {
  const current = generations.get(cy);
  if (current && current.key === key) return current.gen;
  const gen = (current?.gen ?? 0) + 1;
  generations.set(cy, { key, gen });
  return gen;
}

interface Extent {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function paddedExtent(cy: Core): Extent {
  const e = cy.extent();
  const px = e.w * VIEWPORT_PAD;
  const py = e.h * VIEWPORT_PAD;
  return { x1: e.x1 - px, x2: e.x2 + px, y1: e.y1 - py, y2: e.y2 + py };
}

const halfBox = (node: NodeSingular, f: number) => {
  const w = node.data('w');
  const h = node.data('h');
  return {
    hw: ((typeof w === 'number' ? w : 0) * f) / 2,
    hh: ((typeof h === 'number' ? h : 0) * f) / 2
  };
};

function nodeNear(node: NodeSingular, f: number, near: Extent) {
  const p = node.position();
  const { hw, hh } = halfBox(node, f);
  return p.x + hw > near.x1 && p.x - hw < near.x2 && p.y + hh > near.y1 && p.y - hh < near.y2;
}

function edgeNear(edge: EdgeSingular, f: number, near: Extent) {
  const s = edge.source();
  const t = edge.target();
  const sp = s.position();
  const tp = t.position();
  const sb = halfBox(s, f);
  const tb = halfBox(t, f);
  return (
    Math.max(sp.x + sb.hw, tp.x + tb.hw) > near.x1 &&
    Math.min(sp.x - sb.hw, tp.x - tb.hw) < near.x2 &&
    Math.max(sp.y + sb.hh, tp.y + tb.hh) > near.y1 &&
    Math.min(sp.y - sb.hh, tp.y - tb.hh) < near.y2
  );
}

export interface ViewScaleOptions {
  /** Restyle only what is near the viewport; everything else is reported stale. */
  viewportOnly?: boolean;
  /** Drop the render ceilings — layouts read the true drawn geometry. */
  unclamped?: boolean;
}

/**
 * Write the `…View` twin of every size-like property.
 *
 * `w`/`h`, `lineWidth` and `labelWidth` already carry the per-room scalar and the
 * global base size, baked into the element data so the layouts space the boxes
 * they will draw. Everything here is multiplied by the compensation factor and by
 * the global render ratio, which is what keeps the relative sizes exact.
 *
 * @returns how many elements were skipped as off-screen and left stale.
 */
export function applyViewScale(
  cy: Core,
  f: number,
  settings: Settings,
  budget: GeometryBudget,
  opts: ViewScaleOptions = {}
): number {
  const cull = settings.hideSmallLabels;
  const base = Math.max(0.05, settings.baseScale);
  const unclamped = opts.unclamped === true;
  const ratios: RenderRatios = unclamped ? { box: 1, text: 1 } : renderRatios(cy.zoom(), f, budget);

  const gen = generationFor(cy, `${f}|${ratios.box}|${ratios.text}|${base}|${cull ? 1 : 0}`);
  const near = opts.viewportOnly ? paddedExtent(cy) : null;
  let stale = 0;

  cy.batch(() => {
    cy.nodes().forEach((n) => {
      if (n.scratch(GENERATION) === gen) return;

      const d = n.data();
      /* a brand-new element has no `…View` at all and must never be deferred */
      const initialised = typeof d.fontView === 'number';
      if (near && initialised && typeof d.w === 'number' && !nodeNear(n, f, near)) {
        stale++;
        return;
      }

      const isGroup = d.kind === 'group';
      const isPortal = d.portalSide !== undefined;
      /* one scalar for the box and everything drawn inside it */
      const k = sizeOf(d) * base * f * ratios.box;

      const view: Record<string, number> = {
        /* a grouping's name is bounded by nothing, so it takes the label ratio */
        fontView: isGroup
          ? FONT.group * base * f * ratios.text
          : (isPortal ? FONT.portal : FONT.location) * k,
        minFontView: cull
          ? isGroup
            ? MIN_FONT.group
            : isPortal
              ? MIN_FONT.portal
              : MIN_FONT.location
          : 0,
        textMarginYView: (d.textMarginY ?? 0) * k,
        borderView: (isGroup ? 2 : isPortal ? 1.5 : d.hasNotes ? 5 : 2) * k,
        borderStrongView: 5 * k,
        borderNeighbourView: 4 * k
      };

      if (typeof d.w === 'number' && typeof d.h === 'number') {
        view.wView = d.w * f * ratios.box;
        view.hView = d.h * f * ratios.box;
      }
      if (typeof d.textMaxWidth === 'number') view.textMaxWidthView = d.textMaxWidth * k;
      if (isGroup) {
        view.paddingView = 30 * base * f * ratios.box;
        view.groupLabelOffsetView = -8 * base * f * ratios.text;
      }

      n.data(view);
      n.scratch(GENERATION, gen);
    });

    const edgeFont = FONT.edge * base * f * ratios.text;
    const edgeMinFont = cull ? MIN_FONT.edge : 0;

    cy.edges().forEach((e) => {
      if (e.scratch(GENERATION) === gen) return;

      const raw = e.data('lineWidth');
      const initialised = typeof e.data('lineWidthView') === 'number';
      if (near && initialised && !edgeNear(e, f, near)) {
        stale++;
        return;
      }

      const lineWidth = (typeof raw === 'number' ? raw : 2 * base) * f * ratios.box;
      e.data({
        lineWidthView: lineWidth,
        lineWidthHlView: lineWidth + 2 * base * f * ratios.box,
        fontView: edgeFont,
        minFontView: edgeMinFont
      });
      e.scratch(GENERATION, gen);
    });
  });

  return stale;
}

/** The reconcile calls this for any element whose own geometry changed. */
export function invalidateViewScale(ele: { removeScratch(ns: string): unknown }) {
  ele.removeScratch(GENERATION);
}
