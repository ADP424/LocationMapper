import { PALETTE } from './model';

/**
 * Cytoscape stylesheet (typed loosely on purpose — Cytoscape's own style
 * typings are narrower than the runtime).
 *
 * Ordering matters: Cytoscape resolves conflicts by *last matching rule*,
 * so highlight / fade / ghost rules must stay at the bottom.
 */
export const graphStyle: any[] = [
  /* ------------------------------------------------------------- locations */
  {
    selector: 'node.location',
    style: {
      shape: 'data(shape)',
      'background-color': 'data(fill)',
      'border-color': 'data(border)',
      'border-width': 2,
      width: 'label',
      height: 'label',
      padding: '12px',
      label: 'data(label)',
      color: 'data(textColor)',
      'text-wrap': 'wrap',
      'text-max-width': '170px',
      'text-valign': 'center',
      'text-halign': 'center',
      'font-size': 12,
      'font-family': 'Inter, system-ui, sans-serif',
      'min-zoomed-font-size': 6,
      'overlay-color': PALETTE.neighbour,
      'overlay-opacity': 0,
      'transition-property': 'border-color, border-width, opacity',
      'transition-duration': '120ms'
    }
  },
  { selector: 'node.location.has-notes', style: { 'border-style': 'double', 'border-width': 5 } },
  { selector: 'node.location.pinned', style: { 'border-color': '#b7791f' } },

  /* ------------------------------------------------------- layer compounds */
  {
    selector: 'node.layer-group',
    style: {
      shape: 'round-rectangle',
      'background-color': '#dde5f0',
      'background-opacity': 0.6,
      'border-color': '#9aa9bf',
      'border-width': 1,
      'border-style': 'dashed',
      label: 'data(label)',
      color: '#55657d',
      'text-valign': 'top',
      'text-halign': 'center',
      'font-size': 16,
      padding: '28px'
    }
  },

  /* ------------------------------------------------------- ephemeral stubs */
  {
    selector: 'node.portal',
    style: {
      shape: 'tag',
      'background-color': '#ffffff',
      'background-opacity': 0.96,
      'border-width': 1.5,
      'border-style': 'dashed',
      'border-color': 'data(lineColor)',
      width: 'label',
      height: 'label',
      padding: '7px',
      label: 'data(label)',
      color: 'data(lineColor)',
      'font-size': 10,
      'font-style': 'italic',
      'text-valign': 'center',
      'text-halign': 'center',
      'text-wrap': 'wrap',
      'text-max-width': '180px',
      'min-zoomed-font-size': 6
    }
  },

  /* ----------------------------------------------------------------- edges */
  {
    selector: 'edge',
    style: {
      width: 'data(lineWidth)',
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
      'font-size': 11,
      'text-background-color': '#f2f5fa',
      'text-background-opacity': 0.88,
      'text-background-padding': '2px',
      'text-background-shape': 'roundrectangle',
      'text-rotation': 'autorotate',
      'min-zoomed-font-size': 7,
      'transition-property': 'line-color, opacity, width',
      'transition-duration': '120ms'
    }
  },
  {
    selector: 'edge.stub',
    style: { 'curve-style': 'straight', 'line-style': 'dashed', 'arrow-scale': 1 }
  },

  /* ------------------------------------------------------ selection states */
  {
    selector: 'node.hl-neighbor',
    style: { 'border-color': PALETTE.neighbour, 'border-width': 4, 'z-index': 900 }
  },
  {
    selector: 'edge.hl-neighbor',
    style: {
      'line-color': PALETTE.neighbour,
      'target-arrow-color': PALETTE.neighbour,
      'source-arrow-color': PALETTE.neighbour,
      'z-index': 900
    }
  },
  /* node highlight = border only, so the box keeps hugging its label */
  {
    selector: 'node.hl-primary',
    style: {
      'border-color': PALETTE.highlight,
      'border-width': 5,
      'border-style': 'solid',
      'z-index': 999
    }
  },
  {
    selector: 'edge.hl-primary',
    style: {
      'line-color': PALETTE.highlight,
      'target-arrow-color': PALETTE.highlight,
      'source-arrow-color': PALETTE.highlight,
      width: 'data(lineWidthHl)',
      'z-index': 999
    }
  },
  {
    selector: 'node.connect-source',
    style: { 'border-color': '#d6336c', 'border-width': 5, 'border-style': 'double' }
  },
  { selector: '.faded', style: { opacity: 0.18, 'text-opacity': 0.12 } },
  { selector: ':parent.faded', style: { opacity: 0.35 } },

  /* ----------------------------------------- rubber band while connecting */
  {
    selector: 'node.ghost',
    style: { width: 6, height: 6, 'background-color': PALETTE.highlight, events: 'no', label: '' }
  },
  {
    selector: 'edge.ghost-edge',
    style: {
      width: 3,
      'line-color': PALETTE.highlight,
      'line-style': 'dashed',
      'target-arrow-color': PALETTE.highlight,
      'target-arrow-shape': 'triangle',
      'curve-style': 'straight',
      events: 'no',
      label: ''
    }
  }
];
