import type { ElementDefinition } from 'cytoscape';
import type { Connection, Location } from '../types';
import {
  PALETTE,
  normaliseLineStyle,
  normaliseShape,
  weightToWidth
} from './model';

export type LabelMode = 'names' | 'all' | 'none';

export interface BuildOptions {
  labelMode: LabelMode;
  groupByLayer: boolean;
  /** Positions from in-flight drags that have not been persisted yet. */
  positionOverrides?: Record<string, { x: number; y: number }>;
}

/** A locked connection is open once every required location has been visited. */
export function isEffectivelyLocked(
  conn: Connection,
  visited: ReadonlySet<string>
): boolean {
  if (!conn.locked) return false;
  if (conn.requires.length === 0) return true; // permanent / manual gate
  return conn.requires.some((id) => !visited.has(id));
}

export function describeLock(
  conn: Connection,
  locations: Record<string, Location>
): string {
  if (!conn.locked) return '';
  if (!conn.requires.length) {
    return conn.lockNote || 'Locked (no unlock condition recorded).';
  }
  const names = conn.requires.map((id) => locations[id]?.name || 'Unnamed Location');
  return `Unlocks after visiting: ${names.join(', ')}`;
}

const safeName = (l: Location | undefined) => (l?.name && l.name.trim()) || 'Unnamed';

export function buildElements(
  locations: Location[],
  connections: Connection[],
  opts: BuildOptions
): ElementDefinition[] {
  const nodes: ElementDefinition[] = [];
  const edges: ElementDefinition[] = [];

  const overrides = opts.positionOverrides ?? {};
  const visited = new Set(locations.filter((l) => l.visited).map((l) => l.id));
  const byId = new Map(locations.map((l) => [l.id, l]));
  const showLabels = opts.labelMode !== 'none';

  const positionOf = (l: Location | undefined) => {
    if (!l) return undefined;
    const o = overrides[l.id];
    if (o) return { x: o.x, y: o.y };
    if (l.x !== null && l.y !== null) return { x: l.x, y: l.y };
    return undefined;
  };

  /* optional compound grouping by layer (floor / level / district) */
  if (opts.groupByLayer) {
    for (const layer of new Set(locations.map((l) => l.layer).filter(Boolean))) {
      nodes.push({
        data: { id: `layer:${layer}`, kind: 'layer', label: layer },
        classes: 'layer-group',
        selectable: false,
        grabbable: false
      });
    }
  }

  /* ------------------------------------------------------------- locations */
  for (const l of locations) {
    const hasNotes = l.notes.trim().length > 0;
    const bits = [l.name || 'Unnamed Location'];
    if (opts.labelMode === 'all') {
      if (l.layer) bits.push(`«${l.layer}»`);
      if (hasNotes) bits.push('📝');
    }

    nodes.push({
      data: {
        id: l.id,
        kind: 'location',
        label: showLabels ? bits.join('\n') : '',
        name: l.name,
        layer: l.layer,
        shape: normaliseShape(l.kind),
        fill: l.color || (l.visited ? PALETTE.nodeFillVisited : PALETTE.nodeFill),
        border: l.visited ? PALETTE.nodeBorderVisited : PALETTE.nodeBorder,
        textColor: l.textColor || PALETTE.nodeText,
        visited: l.visited,
        hasNotes,
        parent: opts.groupByLayer && l.layer ? `layer:${l.layer}` : undefined
      },
      position: positionOf(l),
      classes: [
        'location',
        l.visited ? 'visited' : 'unvisited',
        hasNotes ? 'has-notes' : '',
        l.pinned ? 'pinned' : ''
      ]
        .filter(Boolean)
        .join(' ')
    });
  }

  /* ----------------------------------------------------------- connections */
  for (const c of connections) {
    const locked = isEffectivelyLocked(c, visited);
    const hasNotes = c.notes.trim().length > 0;
    const lineWidth = weightToWidth(c.weight);

    const shared = {
      connectionId: c.id,
      kind: 'connection',
      name: c.name,
      locked,
      gated: c.locked,
      ephemeral: c.ephemeral,
      hasNotes,
      lineStyle: normaliseLineStyle(c.travelKind),
      lineWidth,
      lineWidthHl: lineWidth + 2,
      textColor: c.textColor || PALETTE.edgeText,
      sourceArrow: c.arrowSource ? 'triangle' : 'none',
      targetArrow: c.arrowTarget ? 'triangle' : 'none'
    };

    const label = (text: string) =>
      showLabels
        ? [locked ? '🔒' : '', opts.labelMode === 'all' && hasNotes ? '📝' : '', text]
            .filter(Boolean)
            .join(' ')
        : '';

    if (!c.ephemeral) {
      edges.push({
        data: {
          ...shared,
          id: c.id,
          source: c.sourceId,
          target: c.targetId,
          lineColor: c.color || (locked ? PALETTE.edgeLocked : PALETTE.edge),
          label: label(c.name)
        },
        classes: ['connection', locked ? 'locked' : '', hasNotes ? 'has-notes' : '']
          .filter(Boolean)
          .join(' ')
      });
      continue;
    }

    /* ---- ephemeral: two detached stubs instead of one long line ---- */
    const src = byId.get(c.sourceId);
    const tgt = byId.get(c.targetId);
    const glyph = c.arrowSource && c.arrowTarget ? '⇄' : c.arrowSource ? '←' : c.arrowTarget ? '→' : '—';
    const suffix = c.name ? ` (${c.name})` : '';
    const outColor = c.color || (locked ? PALETTE.edgeLocked : PALETTE.stubOut);
    const inColor = c.color || (locked ? PALETTE.edgeLocked : PALETTE.stubIn);
    const srcPos = positionOf(src);
    const tgtPos = positionOf(tgt);

    nodes.push({
      data: {
        ...shared,
        id: `${c.id}::out`,
        portalSide: 'out',
        lineColor: outColor,
        label: showLabels ? `${locked ? '🔒 ' : ''}${glyph} To ${safeName(tgt)}${suffix}` : ''
      },
      position: srcPos ? { x: srcPos.x + 150, y: srcPos.y + 60 } : undefined,
      classes: ['portal', 'portal-out', locked ? 'locked' : ''].filter(Boolean).join(' ')
    });

    nodes.push({
      data: {
        ...shared,
        id: `${c.id}::in`,
        portalSide: 'in',
        lineColor: inColor,
        label: showLabels ? `${locked ? '🔒 ' : ''}From ${safeName(src)}${suffix} ${glyph}` : ''
      },
      position: tgtPos ? { x: tgtPos.x - 150, y: tgtPos.y - 60 } : undefined,
      classes: ['portal', 'portal-in', locked ? 'locked' : ''].filter(Boolean).join(' ')
    });

    edges.push({
      data: {
        ...shared,
        id: `${c.id}::out-edge`,
        source: c.sourceId,
        target: `${c.id}::out`,
        lineColor: outColor,
        label: ''
      },
      classes: ['stub', 'stub-out', locked ? 'locked' : ''].filter(Boolean).join(' ')
    });

    edges.push({
      data: {
        ...shared,
        id: `${c.id}::in-edge`,
        source: `${c.id}::in`,
        target: c.targetId,
        lineColor: inColor,
        label: ''
      },
      classes: ['stub', 'stub-in', locked ? 'locked' : ''].filter(Boolean).join(' ')
    });
  }

  // Nodes first so Cytoscape can resolve edge endpoints in a single add().
  return [...nodes, ...edges];
}
