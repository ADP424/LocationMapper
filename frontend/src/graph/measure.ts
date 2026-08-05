/** Cached canvas text measurement — powers label-aware layouts *and* node sizing. */

export const EDGE_LABEL_FONT = '11px Inter, system-ui, -apple-system, sans-serif';
export const NODE_LABEL_FONT = '12px Inter, system-ui, -apple-system, sans-serif';
export const PORTAL_LABEL_FONT = 'italic 10px Inter, system-ui, -apple-system, sans-serif';
export const GROUP_LABEL_FONT = 'bold 15px Inter, system-ui, -apple-system, sans-serif';

/** Matches the `line-height` Cytoscape uses for wrapped labels at these sizes. */
export const NODE_LINE_HEIGHT = 15;
export const PORTAL_LINE_HEIGHT = 13;

const cache = new Map<string, number>();
let ctx: CanvasRenderingContext2D | null | undefined;

function context(): CanvasRenderingContext2D | null {
  if (ctx === undefined) {
    ctx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  }
  return ctx;
}

export function measureTextWidth(text: string, font = EDGE_LABEL_FONT): number {
  if (!text) return 0;
  const key = `${font}|${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const c = context();
  const width = c ? ((c.font = font), c.measureText(text).width) : text.length * 6.4;

  if (cache.size > 8000) cache.clear();
  cache.set(key, width);
  return width;
}

/** Widest line of an already-wrapped label. */
export function measureLabelWidth(text: string, font = EDGE_LABEL_FONT): number {
  if (!text) return 0;
  return text.split('\n').reduce((max, line) => Math.max(max, measureTextWidth(line, font)), 0);
}

/**
 * Greedy word wrap. We wrap in JS (rather than letting Cytoscape do it) so that
 * the node box can be sized from the *exact* lines that will be rendered.
 */
export function wrapLabel(text: string, maxWidth: number, font = NODE_LABEL_FONT): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push('');
      continue;
    }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const candidate = `${line} ${words[i]}`;
      if (measureTextWidth(candidate, font) <= maxWidth) line = candidate;
      else {
        out.push(line);
        line = words[i];
      }
    }
    out.push(line);
  }
  return out;
}
