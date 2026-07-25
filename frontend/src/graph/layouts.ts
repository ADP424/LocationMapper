import type { LayoutOptions } from 'cytoscape';

export type LayoutName =
  | 'elk-layered'
  | 'elk-mrtree'
  | 'fcose'
  | 'breadthfirst'
  | 'concentric'
  | 'grid'
  | 'preset';

export const LAYOUT_LABELS: Record<LayoutName, string> = {
  'elk-layered': 'ELK layered (tidy, few crossings)',
  'elk-mrtree': 'ELK tree',
  fcose: 'fCoSE (force, fast for huge graphs)',
  breadthfirst: 'Breadth-first',
  concentric: 'Concentric',
  grid: 'Grid',
  preset: 'Saved positions'
};

export function layoutOptions(name: LayoutName, nodeCount: number): LayoutOptions {
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
          'elk.edgeRouting': 'ORTHOGONAL',
          'elk.spacing.nodeNode': 55,
          'elk.layered.spacing.nodeNodeBetweenLayers': 110,
          'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
          'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
          'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
          'elk.separateConnectedComponents': true,
          'elk.spacing.componentComponent': 120
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
          'elk.spacing.nodeNode': 60
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
        nodeSeparation: 110,
        idealEdgeLength: () => 140,
        nodeRepulsion: () => 10_000,
        numIter: nodeCount > 1500 ? 1200 : 2500,
        gravity: 0.3,
        gravityRangeCompound: 1.5,
        tile: true
      } as unknown as LayoutOptions;
    case 'breadthfirst':
      return {
        name: 'breadthfirst',
        directed: true,
        spacingFactor: 1.4,
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
        minNodeSpacing: 40,
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
        nodeDimensionsIncludeLabels: true
      };
    case 'preset':
    default:
      return { name: 'preset', fit: true, padding: 60, animate: false };
  }
}
