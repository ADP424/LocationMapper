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

/** Summary of how much room the edge labels need. */
export interface LayoutMetrics {
  nodeCount: number;
  maxEdgeLabelWidth: number;
  avgEdgeLabelWidth: number;
  p90EdgeLabelWidth: number;
}

export function computeMetrics(labelWidths: number[], nodeCount: number): LayoutMetrics {
  const widths = labelWidths.filter((w) => w > 0).sort((a, b) => a - b);
  if (!widths.length) {
    return { nodeCount, maxEdgeLabelWidth: 0, avgEdgeLabelWidth: 0, p90EdgeLabelWidth: 0 };
  }
  const sum = widths.reduce((a, b) => a + b, 0);
  return {
    nodeCount,
    maxEdgeLabelWidth: widths[widths.length - 1],
    avgEdgeLabelWidth: sum / widths.length,
    p90EdgeLabelWidth: widths[Math.min(widths.length - 1, Math.floor(widths.length * 0.9))]
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Layout options tuned so that edge labels always have room to be read.
 *  - ELK layered: labels live in the gap *between layers*, so that gap scales.
 *  - fCoSE: per-edge ideal length, so only the long labels push nodes apart.
 *  - simple layouts: global spacing factors.
 */
export function layoutOptions(name: LayoutName, metrics: LayoutMetrics): LayoutOptions {
  const { nodeCount, avgEdgeLabelWidth: avg, p90EdgeLabelWidth: p90 } = metrics;
  const animate = nodeCount <= 400;

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
          'elk.spacing.nodeNode': clamp(55 + avg * 0.25, 55, 220),
          'elk.layered.spacing.nodeNodeBetweenLayers': clamp(130 + p90 * 0.95, 130, 900),
          'elk.spacing.edgeLabel': 12,
          'elk.spacing.edgeNode': clamp(40 + avg * 0.2, 40, 160),
          'elk.spacing.edgeEdge': 25,
          'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
          'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
          'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
          'elk.separateConnectedComponents': true,
          'elk.spacing.componentComponent': clamp(140 + p90 * 0.5, 140, 600)
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
          'elk.spacing.nodeNode': clamp(70 + p90 * 0.85, 70, 600),
          'elk.spacing.edgeNode': clamp(40 + avg * 0.25, 40, 200),
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
        /* long connection names get proportionally longer edges */
        idealEdgeLength: (edge: any) => 95 + (edge.data('labelWidth') ?? 0) * 1.15,
        edgeElasticity: () => 0.4,
        nodeSeparation: clamp(110 + avg * 0.4, 110, 400),
        nodeRepulsion: () => clamp(9_000 + p90 * 70, 9_000, 60_000),
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
        minNodeSpacing: clamp(45 + p90 * 0.7, 45, 320),
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
