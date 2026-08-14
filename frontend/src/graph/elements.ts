import type { ElementDefinition } from 'cytoscape';
import type { Connection, Group, Location } from '../types';
import { isEffectivelyLocked } from './connectionRules';
import { formatCoordinates } from './coordinateLayout';
import { buildGroupTree, flattenGroupTree, renderableGroupIds } from './groups';
import {
  EDGE_LABEL_FONT,
  GROUP_LABEL_FONT,
  GROUP_LINE_HEIGHT,
  NODE_LABEL_FONT,
  NODE_LINE_HEIGHT,
  PORTAL_LABEL_FONT,
  PORTAL_LINE_HEIGHT,
  measureLabelWidth,
  measureTextWidth,
  wrapLabel
} from './measure';
import {
  GROUP_OPACITY,
  PALETTE,
  PLATE_PAD,
  effectiveLineStyle,
  normaliseShape,
  normaliseGroupDisplay,
  resolveGroupPadding,
  shapeMetrics,
  weightToWidth
} from './model';
import type { EphemeralStyle } from '../state/settings';

export type LabelMode = 'names' | 'all' | 'none';

export interface BuildOptions {
  labelMode: LabelMode;
  /** Global multiplier on every drawn *name* (`settings.baseScale`). Boxes never scale with it. */
  baseScale: number;
  /** Detached stub boxes, or bare arrows into space. */
  ephemeralStyle: EphemeralStyle;
  positionOverrides?: Record<string, { x: number; y: number }>;
  /** Pending (unsaved) stub offsets, keyed by portal node id. */
  portalOffsetOverrides?: Record<string, { dx: number; dy: number }>;
  /** Label id -> display name, for the "Names + Badges" mode. */
  locationLabelNames?: Record<string, string>;
  connectionLabelNames?: Record<string, string>;
}

export const groupNodeId = (groupId: string) => `grp:${groupId}`;

/** Ids we create transiently for ghosts / drag handles — never persisted. */
export const isInternalId = (id: string) => id.startsWith('__');

export const portalNodeId = (connectionId: string, side: 'out' | 'in') => `${connectionId}::${side}`;
export const portalEdgeId = (connectionId: string, side: 'out' | 'in') =>
  `${portalNodeId(connectionId, side)}-edge`;

/** `<uuid>::out` / `<uuid>::in` -> parts. Stub *edges* (`::out-edge`) never match. */
export function parsePortalId(id: string): { connectionId: string; side: 'out' | 'in' } | null {
  const m = /^(.+)::(out|in)$/.exec(id);
  return m ? { connectionId: m[1], side: m[2] as 'out' | 'in' } : null;
}

const MAX_LABEL_WIDTH = 170;

/* ----------------------------------------------------------- memoisation */
interface MemoEntry {
  sig: string;
  els: ElementDefinition[];
}
const groupMemo = new WeakMap<Group, MemoEntry>();
const locationMemo = new WeakMap<Location, MemoEntry>();
const connectionMemo = new WeakMap<Connection, MemoEntry>();

/**
 * Store rows are immutable — every edit replaces the row object — so a row's
 * identity plus a signature of the *external* inputs (label mode, base scale,
 * parent visibility, label names, lock state, endpoint names) fully keys its
 * element definitions. The per-store-change rebuild drops from
 * O(elements × text measurement) to O(elements) WeakMap lookups, with real
 * work only for rows that changed. Definitions are shared across builds:
 * callers must not mutate them, and `syncGraph`/`reconcile` must clone before
 * handing one to `cy.add`, since Cytoscape takes ownership of the data object.
 */
function memo<T extends object>(
  cache: WeakMap<T, MemoEntry>,
  row: T,
  sig: string,
  build: () => ElementDefinition[]
): ElementDefinition[] {
  const hit = cache.get(row);
  if (hit && hit.sig === sig) return hit.els;
  const entry = { sig, els: build() };
  cache.set(row, entry);
  return entry.els;
}

/** A location's box scalar; anything invalid falls back to "normal". */
const sizeOf = (l: Location) => (Number.isFinite(l.size) && l.size > 0 ? l.size : 1);
const prettyNumber = (n: number) => String(Math.round(n * 100) / 100);

export function describeLock(conn: Connection, locations: Record<string, Location>): string {
  if (!conn.locked) return '';
  if (!conn.requires.length) return conn.lockNote || 'Locked (no unlock condition recorded).';
  const names = conn.requires.map((id) => locations[id]?.name || 'Unnamed Location');
  return `Unlocks after visiting: ${names.join(', ')}`;
}

const safeName = (l: Location | undefined) => (l?.name && l.name.trim()) || 'Unnamed';

/**
 * Size a node so the label fits *inside* the shape at the base font, not just
 * its bounding box. `scale` is the location's own size scalar — it multiplies
 * the box here, once, at build time. Name Size is deliberately absent: boxes
 * never change size at runtime for any reason, including this setting.
 */
function boxFor(label: string, shape: string, font: string, lineHeight: number, scale = 1) {
  const lines = label ? label.split('\n') : [];
  const textW = lines.reduce((max, line) => Math.max(max, measureTextWidth(line, font)), 0);
  const textH = Math.max(lines.length, 1) * lineHeight;
  const m = shapeMetrics(shape);
  return {
    w: Math.max(48, Math.round(textW * m.wFactor + m.padX)) * scale,
    h: Math.max(34, Math.round(textH * m.hFactor + m.padY)) * scale,
    /* keep Cytoscape from re-wrapping differently than we measured */
    textMaxWidth: Math.max(24, Math.ceil(textW) + 6),
    textMarginY: m.textMarginY ?? 0
  };
}

/**
 * The name's own drawn footprint — the opaque plate — at compensation 1.
 * Carries `size × Name Size`, because every layout, the content extent and
 * the draw order have to know whichever of the box or the name is bigger.
 */
function plateFor(label: string, font: string, lineHeight: number, size: number, nameScale: number) {
  if (!label) return { lw: 0, lh: 0 };
  const textW = measureLabelWidth(label, font);
  const lines = Math.max(1, label.split('\n').length);
  const k = size * nameScale;
  return {
    lw: (textW + PLATE_PAD * 2) * k,
    lh: (lines * lineHeight + PLATE_PAD * 2) * k
  };
}

export function buildElements(
  locations: Location[],
  connections: Connection[],
  groups: Group[],
  opts: BuildOptions
): ElementDefinition[] {
  const nodes: ElementDefinition[] = [];
  const edges: ElementDefinition[] = [];

  const overrides = opts.positionOverrides ?? {};
  const offsetOverrides = opts.portalOffsetOverrides ?? {};
  /* baked into the geometry, so every layout spaces the boxes it will draw */
  const scale = Number.isFinite(opts.baseScale) && opts.baseScale > 0 ? opts.baseScale : 1;
  const visited = new Set(locations.filter((l) => l.visited).map((l) => l.id));
  const byId = new Map(locations.map((l) => [l.id, l]));
  const showLabels = opts.labelMode !== 'none';

  const memberCount = new Map<string, number>();
  for (const l of locations) {
    for (const gid of l.groupIds) memberCount.set(gid, (memberCount.get(gid) ?? 0) + 1);
  }

  /* a grouping is drawn when it — or anything nested in it — holds a room */
  const visible = renderableGroupIds(groups, memberCount);
  const liveGroups = new Map(groups.filter((g) => visible.has(g.id)).map((g) => [g.id, g]));

  /* the anchor (oldest membership) is the compound parent; if its grouping is
     not drawn, the next-oldest drawn membership quietly takes over containment */
  const parentOf = (l: Location | undefined) => {
    for (const gid of l?.groupIds ?? []) {
      if (liveGroups.has(gid)) return groupNodeId(gid);
    }
    return undefined;
  };

  /* parents must be added before their children (compound nesting on add) */
  const orderedGroups = flattenGroupTree(buildGroupTree([...liveGroups.values()])).map((n) => n.group);

  const positionOf = (l: Location | undefined) => {
    if (!l) return undefined;
    const o = overrides[l.id];
    if (o) return { x: o.x, y: o.y };
    if (l.x !== null && l.y !== null) return { x: l.x, y: l.y };
    return undefined;
  };

  /* identity view twins: `buildElements` bakes in the un-scaled geometry, and
     the ViewScaler's serial 0 (the identity ViewScale) is what a brand-new
     element is deemed to already carry — so with sizing off nothing is ever
     written to a freshly-added element at all */
  const common = `${opts.labelMode}|${scale}|${opts.ephemeralStyle}`;

  /* -------------------------------------------------------- groupings */
  for (const g of orderedGroups) {
    const parent = g.parentId && liveGroups.has(g.parentId) ? groupNodeId(g.parentId) : undefined;
    const count = memberCount.get(g.id) ?? 0;
    const rawGroupW = showLabels ? measureTextWidth(g.name || 'Unnamed Grouping', GROUP_LABEL_FONT) : 0;
    const displayStyle = normaliseGroupDisplay(g.displayStyle);
    const bodyPadding = resolveGroupPadding(g.bodyPadding);
    const els = memo(
      groupMemo,
      g,
      `${common}|${parent ?? ''}|${count}|${displayStyle}|${bodyPadding}`,
      () => [
        {
          data: {
            id: groupNodeId(g.id),
            groupId: g.id,
            kind: 'group',
            label: showLabels ? g.name || 'Unnamed Grouping' : '',
            /* `rectangle` is drawn by Cytoscape; the other two suppress the body
               here (see style.ts) and are painted by the GroupShapeLayer overlay */
            displayStyle,
            /* Cytoscape's compound `padding` *and* the overlay's offset distance:
               they have to be the same number or the drawn body and the box the
               title hangs off would not share a top edge */
            bodyPadding,
            /* the hit area is the drawn body, which only GroupShapeLayer knows —
               until the pointer first moves, everything is clickable */
            bodyHit: 1,
            /* a grouping that anchors no rooms (every membership is someone
               else's anchor) is a childless node; GroupBodyStore.apply() places
               and sizes it to its drawn region each sync. Cytoscape ignores
               width/height on a compound parent, so this is a safe default for
               both kinds. */
            leafW: 60,
            leafH: 40,
            /* runtime-owned, written by GroupBodyStore.sync() */
            titleDx: 0,
            titleDy: 0,
            fill: g.color || PALETTE.groupFill,
            border: g.color || PALETTE.groupBorder,
            /* the title falls back to the body colour until it is given its own */
            textColor: g.textColor || g.color || PALETTE.groupBorder,
            memberCount: count,
            /* un-wrapped, so it feeds the label ceiling (see viewScale) */
            labelWidth: rawGroupW * scale,
            lw: rawGroupW * scale,
            lh: rawGroupW ? GROUP_LINE_HEIGHT * scale : 0,
            /* …and these are the *raw* metrics at the base font, with no Base
               Size folded in: in the skeleton `tView` replaces Base Size rather
               than multiplying it, so the drawn title is exactly
               `titleW × tView` wide and `titleH × tView` tall. That identity is
               what lets the fit below hand the title exactly the space it needs. */
            titleW: rawGroupW,
            titleH: rawGroupW ? GROUP_LINE_HEIGHT : 0,
            /* the raw metrics, which only a rename changes. `titleW`/`titleH`
               above are the *scaled* ones, owned by the layering pass — they are
               what the skeleton fit and `text-max-width` read. */
            titleW0: rawGroupW,
            titleH0: rawGroupW ? GROUP_LINE_HEIGHT : 0,
            titleScale: 1,
            /* neutral defaults; the layering pass refines them after every
               arrangement (see graph/layering) */
            zLayer: 1,
            groupFillOpacity: GROUP_OPACITY.fill,
            groupBorderOpacity: GROUP_OPACITY.border,
            /* sub-groupings are simply compound children of their parent */
            parent,
            tView: scale,
            minFontView: 0,
            skel: 0,
            boxW: 0,
            boxH: 0
          },
          classes: 'group',
          /* grouping selection lives in the store and is drawn with `hl-primary`;
             Cytoscape's native selection would only add an overlay flicker */
          selectable: false,
          grabbable: true
        }
      ]
    );
    nodes.push(els[0]);
  }

  /* -------------------------------------------------------- locations */
  for (const l of locations) {
    const parent = parentOf(l);
    const labelSig =
      opts.labelMode === 'all'
        ? (l.labelIds ?? []).map((id) => opts.locationLabelNames?.[id] ?? '').join(',')
        : '';
    /* every membership, not just the anchor — the cohesion layout and the
       overlay's non-anchor bodies both need it, and neither is `parent` */
    const memberOf = l.groupIds.join(',');
    const els = memo(locationMemo, l, `${common}|${parent ?? ''}|${memberOf}|${labelSig}`, () => {
      const hasNotes = l.notes.trim().length > 0;
      const shape = normaliseShape(l.kind);
      const size = sizeOf(l);
      const lines = showLabels ? wrapLabel(l.name || 'Unnamed Location', MAX_LABEL_WIDTH) : [];

      if (showLabels && opts.labelMode === 'all') {
        const labelNames = (l.labelIds ?? [])
          .map((id) => opts.locationLabelNames?.[id])
          .filter(Boolean)
          .join(', ');
        const badges = [
          formatCoordinates(l),
          size !== 1 ? `×${prettyNumber(size)}` : '',
          labelNames ? `#${labelNames}` : '',
          hasNotes ? '📝' : ''
        ]
          .filter(Boolean)
          .join(' ');
        if (badges) lines.push(badges);
      }

      const label = lines.join('\n');
      /* the box fits the name at the base font, times the location's own size
         scalar — Name Size never touches it */
      const box = boxFor(label, shape, NODE_LABEL_FONT, NODE_LINE_HEIGHT, size);
      const plate = plateFor(label, NODE_LABEL_FONT, NODE_LINE_HEIGHT, size, scale);

      return [
        {
          data: {
            id: l.id,
            kind: 'location',
            label,
            name: l.name,
            shape,
            size,
            ...box,
            ...plate,
            /* what a layout must reserve: the box or the name plate, whichever is bigger */
            spanW: Math.max(box.w, plate.lw),
            spanH: Math.max(box.h, plate.lh),
            fill: l.color || (l.visited ? PALETTE.nodeFillVisited : PALETTE.nodeFill),
            border: l.visited ? PALETTE.nodeBorderVisited : PALETTE.nodeBorder,
            textColor: l.textColor || PALETTE.nodeText,
            visited: l.visited,
            hasNotes,
            /* refined by the layering pass right after every arrangement */
            zLayer: 0,
            parent,
            /* every grouping this room belongs to, comma-joined — for the
               layout's cohesion springs and the overlay's non-anchor bodies */
            memberOf,
            tView: size * scale,
            minFontView: 0,
            skel: 0
          },
          position: positionOf(l),
          classes: ['location', l.visited ? 'visited' : 'unvisited', hasNotes ? 'has-notes' : '']
            .filter(Boolean)
            .join(' ')
        }
      ];
    });
    /* a pending (unsaved) drag is the only position the cache can't see */
    const o = overrides[l.id];
    nodes.push(o ? { ...els[0], position: { x: o.x, y: o.y } } : els[0]);
  }

  /* ------------------------------------------------------ connections */
  for (const c of connections) {
    const locked = isEffectivelyLocked(c, visited);
    const labelSig =
      opts.labelMode === 'all'
        ? (c.labelIds ?? []).map((id) => opts.connectionLabelNames?.[id] ?? '').join(',')
        : '';

    const buildShared = () => {
      const hasNotes = c.notes.trim().length > 0;
      /* Name Size is a text multiplier now: line thickness comes from weight alone */
      const lineWidth = weightToWidth(c.weight);
      /* colour is never forced by locked/ephemeral state — only by the user */
      const lineColor = c.color || PALETTE.edge;
      return {
        connectionId: c.id,
        kind: 'connection',
        name: c.name,
        locked,
        gated: c.locked,
        ephemeral: c.ephemeral,
        hasNotes,
        lineColor,
        lineStyle: effectiveLineStyle(c, locked),
        lineWidth,
        textColor: c.textColor || PALETTE.edgeText,
        sourceArrow: c.arrowSource ? 'triangle' : 'none',
        targetArrow: c.arrowTarget ? 'triangle' : 'none'
      };
    };

    if (!c.ephemeral) {
      const els = memo(connectionMemo, c, `${common}|${locked ? 1 : 0}|${labelSig}`, () => {
        const shared = buildShared();
        const connLabelNames =
          opts.labelMode === 'all'
            ? (c.labelIds ?? [])
                .map((id) => opts.connectionLabelNames?.[id])
                .filter(Boolean)
                .map((n) => `#${n}`)
                .join(' ')
            : '';
        const label = showLabels
          ? [locked ? '🔒' : '', opts.labelMode === 'all' && shared.hasNotes ? '📝' : '', c.name, connLabelNames]
              .filter(Boolean)
              .join(' ')
          : '';
        return [
          {
            data: {
              ...shared,
              id: c.id,
              source: c.sourceId,
              target: c.targetId,
              label,
              labelWidth: measureLabelWidth(label, EDGE_LABEL_FONT) * scale,
              tView: scale,
              minFontView: 0,
              lineView: 1,
              edgeHidden: 0
            },
            classes: ['connection', shared.hasNotes ? 'has-notes' : ''].filter(Boolean).join(' ')
          }
        ];
      });
      edges.push(els[0]);
      continue;
    }

    /* ephemeral: two detached stubs — geometry follows the anchor rooms */
    const src = byId.get(c.sourceId);
    const tgt = byId.get(c.targetId);
    const srcParent = parentOf(src);
    const tgtParent = parentOf(tgt);
    const sig = `${common}|${locked ? 1 : 0}|${labelSig}|${safeName(src)}|${safeName(tgt)}|${srcParent ?? ''}|${tgtParent ?? ''}`;

    /* cached as [outStub, inStub, outEdge, inEdge]; stub *positions* and their
       offset overrides are attached fresh each build since anchors move */
    const els = memo(connectionMemo, c, sig, () => {
      const shared = buildShared();
      const glyph = c.arrowSource && c.arrowTarget ? '⇄' : c.arrowSource ? '←' : c.arrowTarget ? '→' : '—';
      const arrows = opts.ephemeralStyle === 'arrows';

      /* where this half goes / comes from — the box's reason to exist in
         'nodes' mode, and (with the connection's own name folded in) what
         rides the line in 'arrows' mode, since there is no box to caption it */
      const outText = `${glyph} To ${safeName(tgt)}`;
      const inText = `From ${safeName(src)} ${glyph}`;

      const connLabelNames =
        opts.labelMode === 'all'
          ? (c.labelIds ?? [])
              .map((id) => opts.connectionLabelNames?.[id])
              .filter(Boolean)
              .map((n) => `#${n}`)
              .join(' ')
          : '';

      const boxLabel = (text: string) => (showLabels && !arrows ? `${locked ? '🔒 ' : ''}${text}` : '');
      /* the name always rides the line, italic (see edge.stub in style.ts) —
         never the stub box; 'arrows' mode has no box, so the line falls back
         to the full description */
      const lineLabel = (text: string) => {
        if (!showLabels) return '';
        const base = arrows ? `${locked ? '🔒 ' : ''}${text}${c.name ? ` · ${c.name}` : ''}` : c.name;
        if (!base) return '';
        return [opts.labelMode === 'all' && shared.hasNotes ? '📝' : '', base, connLabelNames]
          .filter(Boolean)
          .join(' ');
      };

      const outNodeLabel = wrapLabel(boxLabel(outText), 190, PORTAL_LABEL_FONT).join('\n');
      const inNodeLabel = wrapLabel(boxLabel(inText), 190, PORTAL_LABEL_FONT).join('\n');
      const outEdgeLabel = lineLabel(outText);
      const inEdgeLabel = lineLabel(inText);

      /* portals carry no per-location size scalar: their box is static, at 1×.
         In 'arrows' mode the anchor is an invisible 10×10 grab point instead
         of a labelled tag — small enough to read as "nothing", still draggable. */
      const outBox = arrows
        ? { w: 10, h: 10, textMaxWidth: 0, textMarginY: 0 }
        : boxFor(outNodeLabel, 'tag', PORTAL_LABEL_FONT, PORTAL_LINE_HEIGHT, 1);
      const inBox = arrows
        ? { w: 10, h: 10, textMaxWidth: 0, textMarginY: 0 }
        : boxFor(inNodeLabel, 'tag', PORTAL_LABEL_FONT, PORTAL_LINE_HEIGHT, 1);
      const outPlate = arrows ? { lw: 0, lh: 0 } : plateFor(outNodeLabel, PORTAL_LABEL_FONT, PORTAL_LINE_HEIGHT, 1, scale);
      const inPlate = arrows ? { lw: 0, lh: 0 } : plateFor(inNodeLabel, PORTAL_LABEL_FONT, PORTAL_LINE_HEIGHT, 1, scale);

      /* Which end of each stub ends in empty space, and which arrowhead belongs
         there. An arrowhead marks an end you may *arrive at*, so:
            out stub (source room → space): the space end is the target head
            in  stub (space → target room): the space end is the source head
         In 'nodes' mode a head points into a labelled box. In 'arrows' mode the
         head at the free end *is* the terminus and the only cue to the direction
         of travel — so it is drawn larger, and the stub's description is lifted
         off the line, because an opaque name plate pinned to the midpoint of a
         short stub otherwise covers the line and both of its heads. An
         undirected link still ends bare, by design. */
      const stubArrows = {
        sourceArrow: shared.sourceArrow,
        targetArrow: shared.targetArrow,
        arrowScale: arrows ? 1.7 : 1,
        labelLift: arrows ? 14 : 0
      };

      return [
        {
          data: {
            ...shared,
            id: portalNodeId(c.id, 'out'),
            portalSide: 'out',
            anchorId: c.sourceId,
            zLayer: 0,
            /* the default offset no longer needs to clear a Name-Size-scaled box */
            offsetX: c.outDx ?? 170,
            offsetY: c.outDy ?? 80,
            shape: 'tag',
            parent: srcParent,
            label: outNodeLabel,
            ...outBox,
            ...outPlate,
            spanW: Math.max(outBox.w, outPlate.lw),
            spanH: Math.max(outBox.h, outPlate.lh),
            tView: scale,
            minFontView: 0,
            skel: 0
          },
          classes: `portal portal-out${arrows ? ' portal-point' : ''}`
        },
        {
          data: {
            ...shared,
            id: portalNodeId(c.id, 'in'),
            portalSide: 'in',
            anchorId: c.targetId,
            zLayer: 0,
            offsetX: c.inDx ?? -170,
            offsetY: c.inDy ?? -80,
            shape: 'tag',
            parent: tgtParent,
            label: inNodeLabel,
            ...inBox,
            ...inPlate,
            spanW: Math.max(inBox.w, inPlate.lw),
            spanH: Math.max(inBox.h, inPlate.lh),
            tView: scale,
            minFontView: 0,
            skel: 0
          },
          classes: `portal portal-in${arrows ? ' portal-point' : ''}`
        },
        {
          data: {
            ...shared,
            ...stubArrows,
            id: portalEdgeId(c.id, 'out'),
            source: c.sourceId,
            target: portalNodeId(c.id, 'out'),
            label: outEdgeLabel,
            labelWidth: outEdgeLabel ? measureLabelWidth(outEdgeLabel, EDGE_LABEL_FONT) * scale : 0,
            tView: scale,
            minFontView: 0,
            lineView: 1,
            edgeHidden: 0
          },
          classes: 'stub stub-out'
        },
        {
          data: {
            ...shared,
            ...stubArrows,
            id: portalEdgeId(c.id, 'in'),
            source: portalNodeId(c.id, 'in'),
            target: c.targetId,
            label: inEdgeLabel,
            labelWidth: inEdgeLabel ? measureLabelWidth(inEdgeLabel, EDGE_LABEL_FONT) * scale : 0,
            tView: scale,
            minFontView: 0,
            lineView: 1,
            edgeHidden: 0
          },
          classes: 'stub stub-in'
        }
      ];
    });

    /** Stubs live at `anchor + offset`; a pending (unsaved) drag on the stub
     *  itself overrides the stored offset the cached definition carries. */
    const placeStub = (
      def: ElementDefinition,
      anchor: { x: number; y: number } | undefined,
      override: { dx: number; dy: number } | undefined
    ): ElementDefinition => {
      const data = def.data as Record<string, unknown>;
      const dx = override ? override.dx : (data.offsetX as number);
      const dy = override ? override.dy : (data.offsetY as number);
      return {
        ...def,
        data: override ? { ...data, offsetX: dx, offsetY: dy } : data,
        position: anchor ? { x: anchor.x + dx, y: anchor.y + dy } : undefined
      };
    };

    const srcPos = positionOf(src);
    const tgtPos = positionOf(tgt);
    nodes.push(placeStub(els[0], srcPos, offsetOverrides[portalNodeId(c.id, 'out')]));
    nodes.push(placeStub(els[1], tgtPos, offsetOverrides[portalNodeId(c.id, 'in')]));
    edges.push(els[2], els[3]);
  }

  return [...nodes, ...edges];
}
