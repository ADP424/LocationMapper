import type { Connection } from '../types';

/* ----------------------------------------------------------------- palette */
export const PALETTE = {
  nodeFill: '#ffffff',
  nodeFillVisited: '#dff1e5',
  nodeBorder: '#64748b',
  nodeBorderVisited: '#2f9e68',
  nodeText: '#16202f',
  /** One neutral default for every connection — semantics never override colour. */
  edge: '#5a6b85',
  edgeText: '#243448',
  highlight: '#d98e04',
  neighbour: '#1b84a8',
  multiSelect: '#d6336c',
  route: '#7c3aed',
  routeStart: '#2f9e68',
  routeEnd: '#c0392b',
  routeStop: '#4c1d95',
  groupFill: '#8fa7c4',
  groupBorder: '#5d7a9e'
};

/** Neutral translucency of a grouping box; `groupLayers` ramps around it. */
export const GROUP_OPACITY = { fill: 0.18, border: 0.75 };

/**
 * Every name is drawn on an opaque plate in its element's own colour, so that
 * overlapping names occlude — the nearest one stays readable — instead of
 * interleaving into unreadable noise. The padding is per side, in text units:
 * it scales with the name, the same way the font does.
 */
export const PLATE_PAD = 4;

export interface Option {
  value: string;
  label: string;
}

/* ------------------------------------------------------------ node shapes */
export const SHAPE_OPTIONS: Option[] = [
  { value: 'round-rectangle', label: 'Rounded Rectangle' },
  { value: 'rectangle', label: 'Rectangle' },
  { value: 'cut-rectangle', label: 'Cut Rectangle' },
  { value: 'ellipse', label: 'Ellipse' },
  { value: 'round-diamond', label: 'Rounded Diamond' },
  { value: 'diamond', label: 'Diamond' },
  { value: 'hexagon', label: 'Hexagon' },
  { value: 'round-hexagon', label: 'Rounded Hexagon' },
  { value: 'pentagon', label: 'Pentagon' },
  { value: 'heptagon', label: 'Heptagon' },
  { value: 'octagon', label: 'Octagon' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'round-triangle', label: 'Rounded Triangle' },
  { value: 'barrel', label: 'Barrel' },
  { value: 'rhomboid', label: 'Rhomboid' },
  { value: 'tag', label: 'Tag' },
  { value: 'star', label: 'Star' },
  { value: 'vee', label: 'Vee' }
];

const SHAPES = new Set(SHAPE_OPTIONS.map((o) => o.value));
export const DEFAULT_SHAPE = 'round-rectangle';
export const normaliseShape = (kind: string) => (SHAPES.has(kind) ? kind : DEFAULT_SHAPE);

/**
 * How much larger than its text each shape has to be so that nothing clips.
 * A label of w×h needs a bounding box of (w·wFactor + padX) × (h·hFactor + padY),
 * because most of these shapes only contain a fraction of their bounding box.
 */
export interface ShapeMetrics {
  wFactor: number;
  hFactor: number;
  padX: number;
  padY: number;
  /** Nudge the text towards the widest part of the shape (triangles, vee). */
  textMarginY?: number;
}

const SHAPE_METRICS: Record<string, ShapeMetrics> = {
  rectangle: { wFactor: 1, hFactor: 1, padX: 26, padY: 18 },
  'round-rectangle': { wFactor: 1, hFactor: 1, padX: 26, padY: 18 },
  'cut-rectangle': { wFactor: 1.06, hFactor: 1.04, padX: 32, padY: 20 },
  barrel: { wFactor: 1.18, hFactor: 1.02, padX: 32, padY: 20 },
  rhomboid: { wFactor: 1.35, hFactor: 1, padX: 34, padY: 18 },
  tag: { wFactor: 1.2, hFactor: 1, padX: 38, padY: 18 },
  ellipse: { wFactor: 1.45, hFactor: 1.5, padX: 24, padY: 16 },
  diamond: { wFactor: 2.0, hFactor: 2.0, padX: 26, padY: 18 },
  'round-diamond': { wFactor: 2.0, hFactor: 2.0, padX: 26, padY: 18 },
  hexagon: { wFactor: 1.4, hFactor: 1.18, padX: 30, padY: 18 },
  'round-hexagon': { wFactor: 1.42, hFactor: 1.2, padX: 30, padY: 18 },
  pentagon: { wFactor: 1.5, hFactor: 1.55, padX: 28, padY: 20, textMarginY: 4 },
  heptagon: { wFactor: 1.35, hFactor: 1.4, padX: 26, padY: 18 },
  octagon: { wFactor: 1.3, hFactor: 1.32, padX: 26, padY: 18 },
  triangle: { wFactor: 2.15, hFactor: 2.2, padX: 28, padY: 22, textMarginY: 10 },
  'round-triangle': { wFactor: 2.2, hFactor: 2.25, padX: 28, padY: 22, textMarginY: 10 },
  star: { wFactor: 2.7, hFactor: 2.7, padX: 30, padY: 24 },
  vee: { wFactor: 2.3, hFactor: 2.6, padX: 28, padY: 24, textMarginY: -10 }
};

export function shapeMetrics(shape: string): ShapeMetrics {
  return SHAPE_METRICS[shape] ?? SHAPE_METRICS[DEFAULT_SHAPE];
}

/* ------------------------------------------------------------ line styles */
export const LINE_STYLE_OPTIONS: Option[] = [
  { value: 'default', label: 'Default (Automatic)' },
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
  { value: 'dotted', label: 'Dotted' }
];

const LINE_STYLES = new Set(LINE_STYLE_OPTIONS.map((o) => o.value));
export const DEFAULT_LINE_STYLE = 'default';
export const normaliseLineStyle = (kind: string) =>
  LINE_STYLES.has(kind) ? kind : DEFAULT_LINE_STYLE;

/**
 * "Default" lets the app pick a sensible style; any explicit choice always wins.
 * Nothing else (colour included) is ever forced by ephemeral/locked state.
 */
export function effectiveLineStyle(
  conn: Pick<Connection, 'travelKind' | 'ephemeral'>,
  locked: boolean
): 'solid' | 'dashed' | 'dotted' {
  const chosen = normaliseLineStyle(conn.travelKind);
  if (chosen !== 'default') return chosen as 'solid' | 'dashed' | 'dotted';
  return conn.ephemeral || locked ? 'dashed' : 'solid';
}

/* -------------------------------------------------------------- direction */
export type Direction = 'forward' | 'backward' | 'both' | 'none';

export const DIRECTION_OPTIONS: Array<Option & { value: Direction }> = [
  { value: 'forward', label: 'Source → Target' },
  { value: 'backward', label: 'Target → Source' },
  { value: 'both', label: 'Both Ways (⇄)' },
  { value: 'none', label: 'No Direction (—)' }
];

export function directionOf(c: Pick<Connection, 'arrowSource' | 'arrowTarget'>): Direction {
  if (c.arrowSource && c.arrowTarget) return 'both';
  if (c.arrowTarget) return 'forward';
  if (c.arrowSource) return 'backward';
  return 'none';
}

export function arrowsFor(d: Direction): { arrowSource: boolean; arrowTarget: boolean } {
  switch (d) {
    case 'both':
      return { arrowSource: true, arrowTarget: true };
    case 'backward':
      return { arrowSource: true, arrowTarget: false };
    case 'none':
      return { arrowSource: false, arrowTarget: false };
    case 'forward':
    default:
      return { arrowSource: false, arrowTarget: true };
  }
}

export function directionGlyph(c: Pick<Connection, 'arrowSource' | 'arrowTarget'>): string {
  const d = directionOf(c);
  return d === 'both' ? '⇄' : d === 'forward' ? '→' : d === 'backward' ? '←' : '—';
}

/* ------------------------------------- weight -> logarithmic line width */
export function weightToWidth(weight: number): number {
  const w = Number.isFinite(weight) && weight > 0 ? weight : 1;
  return Math.min(14, Math.max(1.5, 1.6 + 1.9 * Math.log2(1 + w)));
}
