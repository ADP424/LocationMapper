import type { Connection } from '../types';

/* ----------------------------------------------------------------- palette */
export const PALETTE = {
  nodeFill: '#ffffff',
  nodeFillVisited: '#dff1e5',
  nodeBorder: '#64748b',
  nodeBorderVisited: '#2f9e68',
  nodeText: '#16202f',
  edge: '#5a6b85',
  edgeLocked: '#c0392b',
  edgeText: '#243448',
  stubOut: '#6d4bb4',
  stubIn: '#1f6fb2',
  highlight: '#d98e04',
  neighbour: '#1b84a8'
};

/* ---------------------------------------------------------- node "shapes" */
export interface Option {
  value: string;
  label: string;
}

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
export const normaliseShape = (kind: string) =>
  SHAPES.has(kind) ? kind : DEFAULT_SHAPE;

/* ------------------------------------------------------------ line styles */
export const LINE_STYLE_OPTIONS: Option[] = [
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
  { value: 'dotted', label: 'Dotted' }
];

const LINE_STYLES = new Set(LINE_STYLE_OPTIONS.map((o) => o.value));
export const DEFAULT_LINE_STYLE = 'solid';
export const normaliseLineStyle = (kind: string) =>
  LINE_STYLES.has(kind) ? kind : DEFAULT_LINE_STYLE;

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
