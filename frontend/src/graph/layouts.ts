import type { LayoutOptions } from 'cytoscape';
import type { CoordinatePlane } from './coordinateLayout';

export type LayoutName =
  | 'elk-layered'
  | 'elk-mrtree'
  | 'fcose'
  | 'breadthfirst'
  | 'concentric'
  | 'grid'
  | 'preset'
  | 'coords-xy'
  | 'coords-xz'
  | 'coords-yz';

export const LAYOUT_LABELS: Record<LayoutName, string> = {
  'elk-layered': 'ELK Layered (Tidy, Few Crossings)',
  'elk-mrtree': 'ELK Tree',
  fcose: 'fCoSE (Force, Fast For Huge Graphs)',
  breadthfirst: 'Breadth-First',
  concentric: 'Concentric',
  grid: 'Grid',
  preset: 'Saved Positions',
  'coords-xy': 'X / Y Plane (X Across, Y Up)',
  'coords-xz': 'X / Z Plane (X Across, Z Up)',
  'coords-yz': 'Y / Z Plane (Y Across, Z Up)'
};

/** Rendered as <optgroup>s, which gives the coordinate layouts their own divider. */
export const LAYOUT_GROUPS: Array<{ label: string; options: LayoutName[] }> = [
  {
    label: 'Automatic',
    options: ['elk-layered', 'elk-mrtree', 'fcose', 'breadthfirst', 'concentric', 'grid', 'preset']
  },
  { label: 'Coordinate Grid', options: ['coords-xy', 'coords-xz', 'coords-yz'] }
];

export const COORDINATE_LAYOUTS: Record<string, CoordinatePlane> = {
  'coords-xy': 'xy',
  'coords-xz': 'xz',
  'coords-yz': 'yz'
};

export const isCoordinateLayout = (name: LayoutName) => name in COORDINATE_LAYOUTS;

/** How much room the edge labels and the node boxes need. */
export interface LayoutMetrics {
  nodeCount: number;
  avgEdgeLabelWidth: number;
  p90EdgeLabelWidth: number;
  /** Node **footprints** — `max(box, name plate)` per axis — in model units. */
  avgNodeSpan: number;
  p90NodeSpan: number;
  /** The Name Size the plates above were measured at. */
  baseScale: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const percentile = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;

export function computeMetrics(
  labelWidths: number[],
  nodeSpans: number[],
  baseScale = 1
): LayoutMetrics {
  const widths = labelWidths.filter((w) => w > 0).sort((a, b) => a - b);
  const spans = nodeSpans.filter((s) => s > 0).sort((a, b) => a - b);
  return {
    nodeCount: nodeSpans.length,
    avgEdgeLabelWidth: mean(widths),
    p90EdgeLabelWidth: percentile(widths, 0.9),
    avgNodeSpan: mean(spans),
    p90NodeSpan: percentile(spans, 0.9),
    baseScale
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Roughly a default-size room with a short name, at Name Size 1. Spacing only
 * grows past this, so a map at Base Size 1 lays out exactly as before. At
 * Base Size 4 a name is the footprint, not the box, so the nominal has to
 * grow with it too or every map reads as "all rooms are oversized".
 */
const NOMINAL_BOX_SPAN = 120;
const NOMINAL_NAME_SPAN = 120;
const nominalSpan = (baseScale: number) => Math.max(NOMINAL_BOX_SPAN, NOMINAL_NAME_SPAN * baseScale);

/**
 * Widest side of a node's *footprint* — box or name plate, whichever is
 * bigger — in the same base units the layout is solved in. A 1x room whose
 * name is drawn four times larger than its box needs four times the elbow
 * room, or long names land on their neighbours. (Headless quotient nodes
 * carry their footprint directly in `w`/`h`, so the `spanW`/`spanH` fallback
 * covers both cases.)
 */
const nodeSpan = (n: any) => {
  const num = (v: unknown, fb: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fb);
  const w = Math.max(num(n.data('w'), n.width()), num(n.data('spanW'), 0));
  const h = Math.max(num(n.data('h'), n.height()), num(n.data('spanH'), 0));
  return Math.max(w, h);
};

/**
 * Layout options tuned so that edge labels always have room to be read and
 * over-sized rooms always have room to sit.
 *  - ELK layered: labels live in the gap *between layers*, so that gap scales.
 *  - fCoSE: per-edge ideal length, so only long labels and big endpoints push
 *    nodes apart.
 *  - simple layouts: global spacing factors (their cell size already comes from
 *    the largest node box, so the scalar is covered).
 *
 * Engines are always fed real node boxes (`nodeDimensionsIncludeLabels`), which
 * is what actually prevents overlap; the terms below add *breathing room* in
 * proportion to how big the big rooms are.
 */
export function layoutOptions(name: LayoutName, metrics: LayoutMetrics): LayoutOptions {
  const { nodeCount, avgEdgeLabelWidth: avg, p90EdgeLabelWidth: p90, p90NodeSpan } = metrics;
  const animate = nodeCount <= 400;
  const nominal = nominalSpan(metrics.baseScale);
  /** Extra space the over-sized rooms deserve; 0 on a default map. */
  const big = Math.max(0, p90NodeSpan - nominal);

  switch (name) {
    case 'elk-layered':
      return {
        name: 'elk',
        nodeDimensionsIncludeLabels: true,
        fit: true,
        padding: 60,
        animate: false,
        elk: {
          algorithm: 'layered',
          'elk.direction': 'RIGHT',
          'elk.edgeRouting': 'POLYLINE',
          'elk.spacing.nodeNode': clamp(55 + avg * 0.25 + big * 0.5, 55, 400),
          'elk.layered.spacing.nodeNodeBetweenLayers': clamp(130 + p90 * 0.95 + big * 0.5, 130, 1200),
          'elk.spacing.edgeLabel': 12,
          'elk.spacing.edgeNode': clamp(40 + avg * 0.2 + big * 0.25, 40, 240),
          'elk.spacing.edgeEdge': 25,
          'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
          'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
          'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
          'elk.separateConnectedComponents': true,
          'elk.spacing.componentComponent': clamp(140 + p90 * 0.5 + big, 140, 900)
        }
      } as unknown as LayoutOptions;

    case 'elk-mrtree':
      return {
        name: 'elk',
        nodeDimensionsIncludeLabels: true,
        fit: true,
        padding: 60,
        animate: false,
        elk: {
          algorithm: 'mrtree',
          'elk.direction': 'DOWN',
          'elk.spacing.nodeNode': clamp(70 + p90 * 0.85 + big * 0.6, 70, 700),
          'elk.spacing.edgeNode': clamp(40 + avg * 0.25 + big * 0.25, 40, 240),
          'elk.spacing.edgeLabel': 12
        }
      } as unknown as LayoutOptions;

    case 'fcose':
      return {
        name: 'fcose',
        quality: nodeCount > 1500 ? 'draft' : 'default',
        randomize: true,
        animate,
        animationDuration: 400,
        fit: true,
        padding: 60,
        nodeDimensionsIncludeLabels: true,
        uniformNodeDimensions: false,
        packComponents: true,
        /* long connection names *and* big endpoints get proportionally longer
           edges, so the name still lands on visible line, not on a box */
        idealEdgeLength: (edge: any) =>
          95 +
          ((edge.data('labelWidth') as number) ?? 0) * 1.15 +
          Math.max(0, (nodeSpan(edge.source()) + nodeSpan(edge.target())) / 2 - nominal),
        edgeElasticity: () => 0.4,
        nodeSeparation: clamp(110 + avg * 0.4 + big * 0.6, 110, 600),
        nodeRepulsion: () => clamp(9_000 + p90 * 70 + big * 120, 9_000, 120_000),
        numIter: nodeCount > 1500 ? 1200 : 2500,
        gravity: 0.25,
        gravityRangeCompound: 1.5,
        nestingFactor: 0.2,
        tile: true
      } as unknown as LayoutOptions;

    case 'breadthfirst':
      return {
        name: 'breadthfirst',
        directed: true,
        spacingFactor: clamp(1.3 + p90 / 240, 1.3, 3.2),
        animate,
        padding: 60,
        avoidOverlap: true,
        nodeDimensionsIncludeLabels: true
      };

    case 'concentric':
      return {
        name: 'concentric',
        animate,
        padding: 60,
        avoidOverlap: true,
        minNodeSpacing: clamp(45 + p90 * 0.7 + big * 0.5, 45, 420),
        concentric: (n: any) => n.degree(),
        levelWidth: () => 2,
        nodeDimensionsIncludeLabels: true
      } as unknown as LayoutOptions;

    case 'grid':
      return {
        name: 'grid',
        animate,
        padding: 60,
        avoidOverlap: true,
        spacingFactor: clamp(1.2 + p90 / 260, 1.2, 3),
        nodeDimensionsIncludeLabels: true
      };

    case 'preset':
    default:
      return { name: 'preset', fit: true, padding: 60, animate: false };
  }
}
