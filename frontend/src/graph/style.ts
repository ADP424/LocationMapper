import { PALETTE } from './model';

/**
 * Rooms and groupings carry a computed `zLayer` (1..N, see graph/layering), so
 * the interaction states have to outrank any conceivable N — a 2 000-room map
 * would otherwise draw ordinary rooms over their own highlight.
 */
const Z = {
  neighbour: 1_000_000,
  primary: 1_100_000,
  route: 1_200_000,
  ghost: 1_250_000,
  dropTarget: 1_300_000,
  handle: 1_400_000
};

/** Ordering matters: Cytoscape resolves conflicts by *last matching rule*. */
export const graphStyle: any[] = [
  /* -------------------------------------------------------- groupings */
  {
    selector: 'node.group',
    style: {
      shape: 'round-rectangle',
      'background-color': 'data(fill)',
      'background-opacity': 'data(groupFillOpacity)',
      'border-color': 'data(border)',
      'border-width': 'data(borderView)',
      'border-opacity': 'data(groupBorderOpacity)',
      /* stacking order among groupings; `z-compound-depth: bottom` keeps the
         whole band under every room, so this only orders the boxes */
      'z-index': 'data(zLayer)',
      padding: 'data(paddingView)',
      label: 'data(label)',
      color: 'data(textColor)',
      'font-size': 'data(fontView)',
      'font-weight': 'bold',
      'text-valign': 'top',
      'text-halign': 'center',
      'text-margin-y': 'data(groupLabelOffsetView)',
      'min-zoomed-font-size': 'data(minFontView)',
      'z-compound-depth': 'bottom',
      'transition-property': 'border-color, background-opacity, opacity',
      'transition-duration': '120ms'
    }
  },

  /* -------------------------------------------------------- locations */
  {
    selector: 'node.location',
    style: {
      shape: 'data(shape)',
      width: 'data(wView)',
      height: 'data(hView)',
      'background-color': 'data(fill)',
      'border-color': 'data(border)',
      'border-width': 'data(borderView)',
      /* draw order: off-plane coordinate, or biggest box first */
      'z-index': 'data(zLayer)',
      label: 'data(label)',
      color: 'data(textColor)',
      'text-wrap': 'wrap',
      'text-max-width': 'data(textMaxWidthView)',
      'text-margin-y': 'data(textMarginYView)',
      'text-valign': 'center',
      'text-halign': 'center',
      'font-size': 'data(fontView)',
      'font-family': 'Inter, system-ui, sans-serif',
      'min-zoomed-font-size': 'data(minFontView)',
      'transition-property': 'border-color, opacity',
      'transition-duration': '120ms'
    }
  },
  { selector: 'node.location.has-notes', style: { 'border-style': 'double' } },

  /* -------------------------------------------------- ephemeral stubs */
  {
    selector: 'node.portal',
    style: {
      shape: 'tag',
      width: 'data(wView)',
      height: 'data(hView)',
      'background-color': '#ffffff',
      'background-opacity': 0.96,
      'border-width': 'data(borderView)',
      'border-style': 'dashed',
      'border-color': 'data(lineColor)',
      /* a stub shares its anchor room's layer */
      'z-index': 'data(zLayer)',
      label: 'data(label)',
      color: 'data(lineColor)',
      'font-size': 'data(fontView)',
      'font-style': 'italic',
      'text-valign': 'center',
      'text-halign': 'center',
      'text-wrap': 'wrap',
      'text-max-width': 'data(textMaxWidthView)',
      'min-zoomed-font-size': 'data(minFontView)'
    }
  },

  /* ------------------------------------------------------------ edges */
  {
    selector: 'edge',
    style: {
      width: 'data(lineWidthView)',
      'line-color': 'data(lineColor)',
      'line-style': 'data(lineStyle)',
      'target-arrow-color': 'data(lineColor)',
      'source-arrow-color': 'data(lineColor)',
      'target-arrow-shape': 'data(targetArrow)',
      'source-arrow-shape': 'data(sourceArrow)',
      'arrow-scale': 1.15,
      'curve-style': 'bezier',
      label: 'data(label)',
      color: 'data(textColor)',
      'font-size': 'data(fontView)',
      'text-background-color': '#f2f5fa',
      'text-background-opacity': 0.88,
      'text-background-padding': '2px',
      'text-background-shape': 'roundrectangle',
      'text-rotation': 'autorotate',
      'min-zoomed-font-size': 'data(minFontView)',
      'transition-property': 'line-color, opacity',
      'transition-duration': '120ms'
    }
  },
  /* stubs keep their own geometry but NOT their own colour or dash pattern */
  { selector: 'edge.stub', style: { 'curve-style': 'straight', 'arrow-scale': 1 } },

  /* ------------------------------------------------- selection states */
  {
    selector: 'node:selected',
    style: {
      'border-color': PALETTE.multiSelect,
      'border-width': 'data(borderStrongView)',
      'overlay-color': PALETTE.multiSelect,
      'overlay-opacity': 0.1,
      'overlay-padding': 5
    }
  },
  {
    selector: 'node.group:selected',
    style: { 'overlay-opacity': 0, 'border-width': 'data(borderNeighbourView)' }
  },

  /* ------------------------------------------------------- planned trip */
  {
    selector: 'node.route-node',
    style: {
      'border-color': PALETTE.route,
      'border-width': 'data(borderStrongView)',
      'z-index': Z.route
    }
  },
  {
    selector: 'edge.route-edge',
    style: {
      'line-color': PALETTE.route,
      'target-arrow-color': PALETTE.route,
      'source-arrow-color': PALETTE.route,
      width: 'data(lineWidthHlView)',
      'z-index': Z.route
    }
  },
  { selector: 'node.route-stop', style: { 'border-color': PALETTE.routeStop, 'border-style': 'double' } },
  { selector: 'node.route-start', style: { 'border-color': PALETTE.routeStart, 'border-style': 'double' } },
  { selector: 'node.route-end', style: { 'border-color': PALETTE.routeEnd, 'border-style': 'double' } },

  {
    selector: 'node.hl-neighbor',
    style: {
      'border-color': PALETTE.neighbour,
      'border-width': 'data(borderNeighbourView)',
      'z-index': Z.neighbour
    }
  },
  {
    selector: 'edge.hl-neighbor',
    style: {
      'line-color': PALETTE.neighbour,
      'target-arrow-color': PALETTE.neighbour,
      'source-arrow-color': PALETTE.neighbour,
      'z-index': Z.neighbour
    }
  },
  {
    selector: 'node.hl-primary',
    style: {
      'border-color': PALETTE.highlight,
      'border-width': 'data(borderStrongView)',
      'border-style': 'solid',
      'z-index': Z.primary
    }
  },
  {
    selector: 'node.group.hl-primary',
    style: { 'background-opacity': 0.3, 'border-opacity': 1 }
  },
  {
    selector: 'edge.hl-primary',
    style: {
      'line-color': PALETTE.highlight,
      'target-arrow-color': PALETTE.highlight,
      'source-arrow-color': PALETTE.highlight,
      width: 'data(lineWidthHlView)',
      'z-index': Z.primary
    }
  },
  {
    selector: 'node.connect-source',
    style: {
      'border-color': PALETTE.multiSelect,
      'border-width': 'data(borderStrongView)',
      'border-style': 'double'
    }
  },

  { selector: '.faded', style: { opacity: 0.18, 'text-opacity': 0.12 } },
  { selector: 'node.group.faded', style: { opacity: 0.35 } },

  /* Route focus: off-route elements are taken out of the picture entirely.
     `display: none` rather than `visibility: hidden` because it also drops them
     out of hit-testing and out of `cy.fit`, which is the point — a route you
     cannot see should not be something you can click by accident either.
     Cytoscape hides an edge whose endpoint is hidden, so only nodes need the
     class for the graph to come apart cleanly. */
  { selector: '.route-hidden', style: { display: 'none' } },

  /* ------------------------------- transient helpers (ghosts, handles) */
  {
    selector: 'node.ghost',
    style: {
      width: 'data(wView)',
      height: 'data(hView)',
      'background-color': PALETTE.highlight,
      /* the rubber band's far end must stay visible over the rooms it crosses */
      'z-index': Z.ghost,
      events: 'no',
      label: ''
    }
  },
  {
    selector: 'edge.ghost-edge',
    style: {
      width: 'data(lineWidthView)',
      'line-color': PALETTE.highlight,
      'line-style': 'dashed',
      'target-arrow-color': PALETTE.highlight,
      'target-arrow-shape': 'triangle',
      'curve-style': 'straight',
      events: 'no',
      label: ''
    }
  },
  {
    selector: 'node.handle',
    style: {
      shape: 'ellipse',
      width: 'data(wView)',
      height: 'data(hView)',
      label: '',
      'background-color': PALETTE.highlight,
      'border-width': 'data(borderView)',
      'border-color': '#ffffff',
      'overlay-opacity': 0,
      'z-index': Z.handle,
      /* rooms inside a grouping are compound children and would otherwise be
         hit-tested above an orphan node no matter what z-index it has */
      'z-compound-depth': 'top'
    }
  },
  { selector: 'edge.reconnecting', style: { opacity: 0.22 } },
  {
    selector: 'edge.reconnect-edge',
    style: {
      width: 'data(lineWidthView)',
      'line-color': PALETTE.highlight,
      'line-style': 'dashed',
      'curve-style': 'straight',
      'target-arrow-shape': 'triangle',
      'target-arrow-color': PALETTE.highlight,
      events: 'no',
      label: ''
    }
  },
  {
    selector: 'node.drop-target',
    style: {
      'border-color': PALETTE.highlight,
      'border-width': 'data(borderStrongView)',
      'z-index': Z.dropTarget
    }
  }
];
