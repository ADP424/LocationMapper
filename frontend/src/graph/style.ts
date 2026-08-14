import type { NodeSingular, EdgeSingular } from 'cytoscape';
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

type Ele = NodeSingular | EdgeSingular;

/** `tView` scales every text-like property. Boxes are static — never scaled at runtime. */
const tv = (ele: Ele) => (ele.data('tView') as number) || 1;
/** The skeleton's line-width multiplier — 1 outside it. */
const lv = (ele: Ele) => (ele.data('lineView') as number) || 1;
const lineW = (e: EdgeSingular) => ((e.data('lineWidth') as number) || 2) * lv(e);

/** Matches `TITLE_GAP` in graph/groupRegions — the title's clearance above its edge. */
const TITLE_GAP = 8;

/** The title, lifted clear of the edge it is anchored to. Scales with the text. */
const titleMarginY = (e: NodeSingular) =>
  ((e.data('titleDy') as number) || 0) - (TITLE_GAP + ((e.data('titleH') as number) || 0) / 2) * tv(e);

/** Ordering matters: Cytoscape resolves conflicts by *last matching rule*. */
export const graphStyle: any[] = [
  /* -------------------------------------------------------- groupings */
  {
    selector: 'node.group',
    style: {
      shape: 'round-rectangle',
      /* a childless (anchorless) grouping has no compound geometry of its own;
         GroupBodyStore.apply() sizes it to its drawn region every sync. A
         compound parent ignores width/height entirely, so this is a safe
         default for both kinds. */
      width: 'data(leafW)',
      height: 'data(leafH)',
      /* the overlay paints every body now, rectangles included — the actual
         zeroing lives in a rule placed after every selection/highlight rule
         below, so no interaction state can put a box back */
      /* stacking order among groupings; `z-compound-depth: bottom` keeps the
         whole band under every room, so this only orders the boxes */
      'z-index': 'data(zLayer)',
      /* an anchored grouping's compound padding — the room the layout reserves
         for its own body around its anchored members */
      padding: (e: NodeSingular) => (e.data('bodyPadding') as number) || 0,
      label: 'data(label)',
      color: 'data(textColor)',
      /* the same family `measure.ts` measures `titleW` with, so the skeleton's
         fitted title really is the width the fit solved for */
      'font-family': 'Inter, system-ui, -apple-system, sans-serif',
      /* 15 px × the grouping's own area-derived scale × the view scale. The
         skeleton's fitted `tView` divides the scale straight back out, so the
         zoomed-out title is sized by the grouping's bounds alone. */
      'font-size': (e: NodeSingular) => 15 * ((e.data('titleScale') as number) || 1) * tv(e),
      'font-weight': 'bold',
      'text-valign': 'center',
      'text-halign': 'center',
      'text-margin-x': 'data(titleDx)',
      /* every grouping's title is anchored to its drawn body's top-most edge —
         `titleDx/titleDy` point from the node's centre to that edge's centre,
         and the margin below lifts the title clear of it. A rectangle's
         top-most edge is simply its own top, so this reduces to the plain
         rectangle placement it has always had. */
      'text-margin-y': titleMarginY,
      /* A grouping's title takes **no** plate. Its colour falls back to the
         body colour, so a plate in that same colour rendered it invisible —
         and, scaled by the skeleton's fit factor, the plate and its border
         dwarfed the text they were supposed to back. */
      'text-wrap': 'none',
      /* exactly as much room as the title needs, and never an inch less, so
         Cytoscape can neither wrap it nor clip it at the sides */
      'text-max-width': (e: NodeSingular) =>
        Math.max(1, ((e.data('titleW') as number) || 0) * tv(e) + 4),
      'min-zoomed-font-size': 'data(minFontView)',
      'z-compound-depth': 'bottom',
      'transition-property': 'border-color, background-opacity, opacity',
      'transition-duration': '120ms'
    }
  },
  /* ── the skeleton view ──────────────────────────────────────────────────
     Once names and rooms are gone, a grouping's title is the only landmark
     left, so it moves to the box's centre and is fitted to it (ViewScaler
     writes `tView` sized for that fit). Placed after the base rule above so
     it wins every property it sets; placed before the selection/highlight
     rules further down so a selected grouping still gets its amber border. */
  /* The skeleton title keeps its size — the ViewScaler still fits it to the
     grouping's total bounds, not to its filled area — and keeps its anchor. It
     simply grows in place, so nothing jumps as you cross the threshold, and it
     can never land in the hole of a loop or off the edge of a rectangle. */
  {
    selector: 'node.group.skel',
    style: {
      'border-width': 3,
      /* the only readable thing left, so it's boosted against the canvas */
      'background-opacity': (e: NodeSingular) =>
        Math.min(0.55, ((e.data('groupFillOpacity') as number) || 0.2) * 1.6),
      'transition-property': 'background-opacity, border-width',
      'transition-duration': '140ms'
    }
  },

  /* -------------------------------------------------------- locations */
  {
    selector: 'node.location',
    style: {
      shape: 'data(shape)',
      width: 'data(w)',
      height: 'data(h)',
      'background-color': 'data(fill)',
      /* the skeleton hides the box itself but keeps the node (and its edges)
         drawing — `opacity: 0` would take the connections down with it */
      'background-opacity': (e: NodeSingular) => (e.data('skel') ? 0 : 1),
      'border-color': 'data(border)',
      'border-width': (e: NodeSingular) => (e.data('skel') ? 0 : e.data('hasNotes') ? 5 : 2),
      /* draw order: off-plane coordinate, or biggest footprint first */
      'z-index': 'data(zLayer)',
      label: 'data(label)',
      color: 'data(textColor)',
      'text-wrap': 'wrap',
      'text-max-width': (e: NodeSingular) => Math.max(1, (e.data('textMaxWidth') || 0) * tv(e)),
      'text-margin-y': (e: NodeSingular) => (e.data('textMarginY') || 0) * tv(e),
      'text-valign': 'center',
      'text-halign': 'center',
      'font-size': (e: NodeSingular) => 12 * tv(e),
      'font-family': 'Inter, system-ui, sans-serif',
      /* ── the name plate ──────────────────────────────────────────────
         A name drawn larger than its room would be illegible the moment two
         of them crossed. So it is drawn on an opaque plate in the room's own
         colour: overlapping names *occlude* each other instead of
         interleaving into noise, and the draw order (biggest footprint
         underneath) decides who wins. The thin border keeps two same-
         coloured plates from visually merging into one shape. */
      'text-background-color': 'data(fill)',
      'text-background-opacity': 1,
      'text-background-shape': 'roundrectangle',
      'text-background-padding': (e: NodeSingular) => 4 * tv(e),
      'text-border-width': (e: NodeSingular) => 1 * tv(e),
      'text-border-color': 'data(border)',
      'text-border-opacity': 0.55,
      'min-zoomed-font-size': 'data(minFontView)',
      /* the name is part of the room: clicking, dragging or right-clicking it
         — or its plate — hits the node, which matters now that names routinely
         outgrow their box */
      'text-events': 'yes',
      'transition-property': 'border-color, opacity, background-opacity, border-width',
      'transition-duration': '140ms'
    }
  },
  { selector: 'node.location.has-notes', style: { 'border-style': 'double' } },

  /* -------------------------------------------------- ephemeral stubs */
  {
    selector: 'node.portal',
    style: {
      shape: 'tag',
      width: 'data(w)',
      height: 'data(h)',
      'background-color': '#ffffff',
      'background-opacity': (e: NodeSingular) => (e.data('skel') ? 0 : 0.96),
      'border-width': (e: NodeSingular) => (e.data('skel') ? 0 : 1.5),
      'border-style': 'dashed',
      'border-color': 'data(lineColor)',
      /* a stub shares its anchor room's layer */
      'z-index': 'data(zLayer)',
      label: 'data(label)',
      color: 'data(lineColor)',
      'font-size': (e: NodeSingular) => 10 * tv(e),
      'font-style': 'italic',
      'text-valign': 'center',
      'text-halign': 'center',
      'text-wrap': 'wrap',
      'text-max-width': (e: NodeSingular) => Math.max(1, (e.data('textMaxWidth') || 0) * tv(e)),
      'text-background-color': '#ffffff',
      'text-background-opacity': 0.96,
      'text-background-shape': 'roundrectangle',
      'text-background-padding': (e: NodeSingular) => 4 * tv(e),
      'text-border-width': (e: NodeSingular) => 1 * tv(e),
      'text-border-color': 'data(lineColor)',
      'text-border-opacity': 0.7,
      'min-zoomed-font-size': 'data(minFontView)',
      'text-events': 'yes',
      'transition-property': 'background-opacity, border-width',
      'transition-duration': '140ms'
    }
  },

  /* ------------------------------------------------------------ edges */
  {
    selector: 'edge',
    style: {
      width: lineW,
      /* The skeleton can be told to drop the lines altogether. `display` is the
         one property no other rule in this stylesheet sets, so neither a
         highlight nor a route dim can resurrect a hidden line — and a
         `display: none` element is skipped by the renderer and by hit testing,
         which is the whole point of the setting. */
      display: (e: EdgeSingular) => (e.data('edgeHidden') ? 'none' : 'element'),
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
      'font-size': (e: EdgeSingular) => 11 * tv(e),
      'text-background-color': '#f2f5fa',
      'text-background-opacity': 0.95,
      'text-background-shape': 'roundrectangle',
      'text-background-padding': (e: EdgeSingular) => 3 * tv(e),
      'text-border-width': (e: EdgeSingular) => 1 * tv(e),
      'text-border-color': 'data(lineColor)',
      'text-border-opacity': 0.45,
      'text-rotation': 'autorotate',
      'min-zoomed-font-size': 'data(minFontView)',
      /* a connection's name plate selects the connection */
      'text-events': 'yes',
      /* the skeleton's thickening is a mode change, not a per-frame effect —
         let the user see the line grow rather than snap */
      'transition-property': 'line-color, opacity, width',
      'transition-duration': '140ms'
    }
  },
  /* stubs keep their own geometry but NOT their own colour or dash pattern;
     the connection's name rides the line, italic, in both ephemeral modes —
     the cue that this is a link to elsewhere, not a room.

     Both ends carry whichever arrowhead the connection designates for them.
     In "arrows into space" mode the free end has no box to arrive at, so that
     head is the terminus: it is scaled up, and the description is lifted clear
     of the line so it cannot paint over the head it is describing. */
  {
    selector: 'edge.stub',
    style: {
      'curve-style': 'straight',
      'font-style': 'italic',
      'source-arrow-shape': 'data(sourceArrow)',
      'target-arrow-shape': 'data(targetArrow)',
      'source-arrow-color': 'data(lineColor)',
      'target-arrow-color': 'data(lineColor)',
      'arrow-scale': (e: EdgeSingular) => (e.data('arrowScale') as number) || 1,
      'text-margin-y': (e: EdgeSingular) => -((e.data('labelLift') as number) || 0) * tv(e)
    }
  },

  /* ------------------------------------------------- selection states */
  {
    selector: 'node:selected',
    style: {
      'border-color': PALETTE.multiSelect,
      'border-width': 5,
      'overlay-color': PALETTE.multiSelect,
      'overlay-opacity': 0.1,
      'overlay-padding': 5
    }
  },
  /* Elements the user pans *through* must not react to the press at all:
     Cytoscape's default stylesheet halos `:active` elements, and the rule above
     tints a selected one — both flicker when the gesture was only a pan. */
  { selector: '.pan-through', style: { 'overlay-opacity': 0 } },

  /* ------------------------------------------------------- planned trip */
  {
    selector: 'node.route-node',
    style: {
      'border-color': PALETTE.route,
      'border-width': 5,
      'z-index': Z.route
    }
  },
  {
    selector: 'edge.route-edge',
    style: {
      'line-color': PALETTE.route,
      'target-arrow-color': PALETTE.route,
      'source-arrow-color': PALETTE.route,
      width: (e: EdgeSingular) => lineW(e) + 2,
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
      'border-width': 4,
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
      'border-width': 5,
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
      width: (e: EdgeSingular) => lineW(e) + 2,
      'z-index': Z.primary
    }
  },
  {
    selector: 'node.connect-source',
    style: {
      'border-color': PALETTE.multiSelect,
      'border-width': 5,
      'border-style': 'double'
    }
  },

  /* Highlighting is additive everywhere except a planned trip, which is
     explicitly a view of the route — and even there the rest of the map stays
     legible: a soft dim, not the old opaque fade that hid names entirely. */
  { selector: '.route-dim', style: { opacity: 0.45, 'text-opacity': 0.4, 'text-background-opacity': 0.35 } },
  { selector: 'node.group.route-dim', style: { opacity: 0.5 } },

  /* ── every grouping's body is painted by the overlay ────────────────────
     Cytoscape compound parents can only be simple shapes, and with any two
     groupings now free to overlap, a Cytoscape-painted rectangle would always
     win the stack regardless of `zLayer`. So the GroupShapeLayer overlay draws
     every body — rectangles included — on a canvas beneath this one. The node
     keeps everything else it is for — containment (for an anchored room), its
     title, its place in the layout — but none of its body is painted here: not
     the fill, not the border, not the grab overlay.

     Placed after every selection, highlight and route rule above, so that no
     interaction state can put a box back. The overlay draws those states
     itself, in the right shape. */
  {
    selector: 'node.group',
    style: {
      'background-opacity': 0,
      'border-width': 0,
      'border-opacity': 0,
      'overlay-opacity': 0
    }
  },
  /* …and a body that is not drawn must not be hit either. `bodyHit` is written
     by GroupShapeLayer from a real point-in-region test, in a capture-phase
     listener that lands before Cytoscape's hit test reads this rule. Everything
     downstream — selection, drag, drop targets, the context menu, the marquee —
     inherits the correct hit area without knowing any of this happened. */
  { selector: 'node.group[bodyHit = 0]', style: { events: 'no' } },

  /* "arrows into space" mode: the anchor is an invisible, still-draggable grab
     point — the arrowhead (inherited from the connection's own direction) or,
     for an undirected link, the line's bare end, is the actual terminus. This
     comes after every selection/highlight rule above so no state can paint a
     border or background onto what is meant to read as nothing. */
  {
    selector: 'node.portal-point',
    style: {
      shape: 'ellipse',
      width: 'data(w)',
      height: 'data(h)',
      label: '',
      'background-opacity': 0,
      'border-width': 0,
      'overlay-opacity': 0,
      'text-events': 'no'
    }
  },
  {
    selector: 'node.portal-point.hl-primary, node.portal-point:active',
    style: {
      'background-color': 'data(lineColor)',
      'background-opacity': 0.95,
      'border-width': 2,
      'border-color': '#ffffff',
      'border-opacity': 1
    }
  },

  /* ------------------------------- transient helpers (ghosts, handles) */
  {
    selector: 'node.ghost',
    style: {
      width: 'data(w)',
      height: 'data(h)',
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
      width: 'data(lineWidth)',
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
      width: 'data(w)',
      height: 'data(h)',
      label: '',
      'background-color': PALETTE.highlight,
      'border-width': 2,
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
      width: 'data(lineWidth)',
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
      'border-width': 5,
      'z-index': Z.dropTarget
    }
  }
];
