import type { ElementDefinition } from 'cytoscape';
import type { Connection, Group, Location } from '../types';
import { isEffectivelyLocked } from './connectionRules';
import { formatCoordinates } from './coordinateLayout';
import { buildGroupTree, flattenGroupTree, renderableGroupIds } from './groups';
import {
  EDGE_LABEL_FONT,
  GROUP_LABEL_FONT,
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
  effectiveLineStyle,
  normaliseShape,
  shapeMetrics,
  weightToWidth
} from './model';

export type LabelMode = 'names' | 'all' | 'none';

export interface BuildOptions {
  labelMode: LabelMode;
  /** Global multiplier on every drawn size (`settings.baseScale`). */
  baseScale: number;
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
 * Size a node so the label fits *inside* the shape, not just its bounding box.
 * `scale` is the location's size scalar: it multiplies the drawn box here, and
 * the text-side properties are multiplied by the same amount when their
 * zoom-compensated twins are computed (see `viewScale`).
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
    if (l.groupId) memberCount.set(l.groupId, (memberCount.get(l.groupId) ?? 0) + 1);
  }

  /* a grouping is drawn when it — or anything nested in it — holds a room */
  const visible = renderableGroupIds(groups, memberCount);
  const liveGroups = new Map(groups.filter((g) => visible.has(g.id)).map((g) => [g.id, g]));

  const parentOf = (l: Location | undefined) =>
    l?.groupId && liveGroups.has(l.groupId) ? groupNodeId(l.groupId) : undefined;

  /* parents must be added before their children (compound nesting on add) */
  const orderedGroups = flattenGroupTree(buildGroupTree([...liveGroups.values()])).map((n) => n.group);

  const positionOf = (l: Location | undefined) => {
    if (!l) return undefined;
    const o = overrides[l.id];
    if (o) return { x: o.x, y: o.y };
    if (l.x !== null && l.y !== null) return { x: l.x, y: l.y };
    return undefined;
  };

  /* -------------------------------------------------------- groupings */
  for (const g of orderedGroups) {
    nodes.push({
      data: {
        id: groupNodeId(g.id),
        groupId: g.id,
        kind: 'group',
        label: showLabels ? g.name || 'Unnamed Grouping' : '',
        fill: g.color || PALETTE.groupFill,
        border: g.color || PALETTE.groupBorder,
        /* the title falls back to the body colour until it is given its own */
        textColor: g.textColor || g.color || PALETTE.groupBorder,
        memberCount: memberCount.get(g.id) ?? 0,
        /* un-wrapped, so it feeds the label ceiling (see viewScale) */
        labelWidth: showLabels
          ? measureTextWidth(g.name || 'Unnamed Grouping', GROUP_LABEL_FONT) * scale
          : 0,
        /* neutral defaults; the layering pass refines them after every
           arrangement (see graph/layering) */
        zLayer: 1,
        groupFillOpacity: GROUP_OPACITY.fill,
        groupBorderOpacity: GROUP_OPACITY.border,
        /* sub-groupings are simply compound children of their parent */
        parent: g.parentId && liveGroups.has(g.parentId) ? groupNodeId(g.parentId) : undefined
      },
      classes: 'group',
      /* grouping selection lives in the store and is drawn with `hl-primary`;
         Cytoscape's native selection would only add an overlay flicker */
      selectable: false,
      grabbable: true
    });
  }

  /* -------------------------------------------------------- locations */
  for (const l of locations) {
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
        l.layer ? `«${l.layer}»` : '',
        size !== 1 ? `×${prettyNumber(size)}` : '',
        labelNames ? `#${labelNames}` : '',
        hasNotes ? '📝' : ''
      ]
        .filter(Boolean)
        .join(' ');
      if (badges) lines.push(badges);
    }

    const label = lines.join('\n');
    const box = boxFor(label, shape, NODE_LABEL_FONT, NODE_LINE_HEIGHT, size * scale);

    nodes.push({
      data: {
        id: l.id,
        kind: 'location',
        label,
        name: l.name,
        layer: l.layer,
        shape,
        size,
        ...box,
        fill: l.color || (l.visited ? PALETTE.nodeFillVisited : PALETTE.nodeFill),
        border: l.visited ? PALETTE.nodeBorderVisited : PALETTE.nodeBorder,
        textColor: l.textColor || PALETTE.nodeText,
        visited: l.visited,
        hasNotes,
        /* refined by the layering pass right after every arrangement */
        zLayer: 0,
        parent: parentOf(l)
      },
      position: positionOf(l),
      classes: ['location', l.visited ? 'visited' : 'unvisited', hasNotes ? 'has-notes' : '']
        .filter(Boolean)
        .join(' ')
    });
  }

  /* ------------------------------------------------------ connections */
  for (const c of connections) {
    const locked = isEffectivelyLocked(c, visited);
    const hasNotes = c.notes.trim().length > 0;
    const lineWidth = weightToWidth(c.weight) * scale;
    /* colour is never forced by locked/ephemeral state — only by the user */
    const lineColor = c.color || PALETTE.edge;

    const shared = {
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

    const connLabelNames =
      opts.labelMode === 'all'
        ? (c.labelIds ?? [])
            .map((id) => opts.connectionLabelNames?.[id])
            .filter(Boolean)
            .map((n) => `#${n}`)
            .join(' ')
        : '';

    const decorate = (text: string) =>
      showLabels
        ? [locked ? '🔒' : '', opts.labelMode === 'all' && hasNotes ? '📝' : '', text, connLabelNames]
            .filter(Boolean)
            .join(' ')
        : '';

    if (!c.ephemeral) {
      const label = decorate(c.name);
      edges.push({
        data: {
          ...shared,
          id: c.id,
          source: c.sourceId,
          target: c.targetId,
          label,
          labelWidth: measureLabelWidth(label, EDGE_LABEL_FONT) * scale
        },
        classes: ['connection', hasNotes ? 'has-notes' : ''].filter(Boolean).join(' ')
      });
      continue;
    }

    /* ephemeral: two detached stubs instead of one long line */
    const src = byId.get(c.sourceId);
    const tgt = byId.get(c.targetId);
    const glyph = c.arrowSource && c.arrowTarget ? '⇄' : c.arrowSource ? '←' : c.arrowTarget ? '→' : '—';
    const suffix = c.name ? ` (${c.name})` : '';
    const srcPos = positionOf(src);
    const tgtPos = positionOf(tgt);

    /** Stubs live at `anchor + offset`, so they travel with their room. */
    const stub = (
      storedDx: number | null,
      storedDy: number | null,
      defaultDx: number,
      defaultDy: number,
      id: string,
      anchor: { x: number; y: number } | undefined
    ) => {
      const override = offsetOverrides[id];
      const dx = override ? override.dx : storedDx ?? defaultDx;
      const dy = override ? override.dy : storedDy ?? defaultDy;
      return {
        offset: { offsetX: dx, offsetY: dy },
        position: anchor ? { x: anchor.x + dx, y: anchor.y + dy } : undefined
      };
    };

    /* the *default* offset must clear a bigger room; a saved one is absolute */
    const outStub = stub(c.outDx, c.outDy, 170 * scale, 80 * scale, portalNodeId(c.id, 'out'), srcPos);
    const inStub = stub(c.inDx, c.inDy, -170 * scale, -80 * scale, portalNodeId(c.id, 'in'), tgtPos);

    const outLabel = showLabels
      ? wrapLabel(`${locked ? '🔒 ' : ''}${glyph} To ${safeName(tgt)}${suffix}`, 190, PORTAL_LABEL_FONT).join('\n')
      : '';
    const inLabel = showLabels
      ? wrapLabel(`${locked ? '🔒 ' : ''}From ${safeName(src)}${suffix} ${glyph}`, 190, PORTAL_LABEL_FONT).join('\n')
      : '';

    nodes.push({
      data: {
        ...shared,
        id: portalNodeId(c.id, 'out'),
        portalSide: 'out',
        anchorId: c.sourceId,
        zLayer: 0,
        ...outStub.offset,
        shape: 'tag',
        parent: parentOf(src),
        label: outLabel,
        ...boxFor(outLabel, 'tag', PORTAL_LABEL_FONT, PORTAL_LINE_HEIGHT, scale)
      },
      position: outStub.position,
      classes: 'portal portal-out'
    });

    nodes.push({
      data: {
        ...shared,
        id: portalNodeId(c.id, 'in'),
        portalSide: 'in',
        anchorId: c.targetId,
        zLayer: 0,
        ...inStub.offset,
        shape: 'tag',
        parent: parentOf(tgt),
        label: inLabel,
        ...boxFor(inLabel, 'tag', PORTAL_LABEL_FONT, PORTAL_LINE_HEIGHT, scale)
      },
      position: inStub.position,
      classes: 'portal portal-in'
    });

    edges.push({
      data: {
        ...shared,
        id: portalEdgeId(c.id, 'out'),
        source: c.sourceId,
        target: portalNodeId(c.id, 'out'),
        label: '',
        labelWidth: 0
      },
      classes: 'stub stub-out'
    });

    edges.push({
      data: {
        ...shared,
        id: portalEdgeId(c.id, 'in'),
        source: portalNodeId(c.id, 'in'),
        target: c.targetId,
        label: '',
        labelWidth: 0
      },
      classes: 'stub stub-in'
    });
  }

  return [...nodes, ...edges];
}
