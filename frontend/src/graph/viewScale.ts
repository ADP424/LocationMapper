import type { Core, NodeSingular } from 'cytoscape';
import type { Settings } from '../state/settings';

/**
 * The *base* (un-zoomed) box of a node. Layouts must always measure with this,
 * never with `node.width()`, which reflects the zoom-compensated drawn size.
 */
export function baseSize(node: NodeSingular) {
  const w = node.data('w');
  const h = node.data('h');
  return {
    w: typeof w === 'number' && w > 0 ? w : node.width(),
    h: typeof h === 'number' && h > 0 ? h : node.height()
  };
}

/**
 * Model-space multiplier that cancels out the zoom.
 *
 *   rendered = model × zoom,  model = base × zoom^(−strength)
 *   ⇒ rendered = base × zoom^(1 − strength)
 *
 * strength 1 → constant on-screen size, 0 → ordinary scaling.
 */
export function viewScaleFactor(zoom: number, settings: Settings): number {
  if (!settings.constantSize || settings.sizeCompensation <= 0) return 1;
  const strength = Math.min(1, Math.max(0, settings.sizeCompensation));
  const z = Math.min(8, Math.max(0.01, zoom));
  return Math.pow(z, -strength);
}

const FONT = { location: 12, portal: 10, group: 15, edge: 11 };
/**
 * Cytoscape drops a label once its *rendered* size falls below
 * `min-zoomed-font-size`; 0 disables that entirely.
 */
const MIN_FONT = { location: 6, portal: 6, group: 5, edge: 7 };

/** Write the `…View` twin of every size-like property, pre-multiplied by `f`. */
export function applyViewScale(cy: Core, f: number, settings: Settings) {
  const cull = settings.hideSmallLabels;
  cy.batch(() => {
    cy.nodes().forEach((n) => {
      const d = n.data();
      const isGroup = d.kind === 'group';
      const isPortal = d.portalSide !== undefined;

      if (typeof d.w === 'number') n.data('wView', d.w * f);
      if (typeof d.h === 'number') n.data('hView', d.h * f);
      if (typeof d.textMaxWidth === 'number') n.data('textMaxWidthView', d.textMaxWidth * f);
      n.data('textMarginYView', (d.textMarginY ?? 0) * f);
      n.data(
        'fontView',
        (isGroup ? FONT.group : isPortal ? FONT.portal : FONT.location) * f
      );
      n.data(
        'minFontView',
        cull ? (isGroup ? MIN_FONT.group : isPortal ? MIN_FONT.portal : MIN_FONT.location) : 0
      );
      n.data('borderView', (isGroup ? 2 : isPortal ? 1.5 : d.hasNotes ? 5 : 2) * f);
      n.data('borderStrongView', 5 * f);
      n.data('borderNeighbourView', 4 * f);
      if (isGroup) {
        n.data('paddingView', 30 * f);
        n.data('groupLabelOffsetView', -8 * f);
      }
    });

    cy.edges().forEach((e) => {
      const base = typeof e.data('lineWidth') === 'number' ? (e.data('lineWidth') as number) : 2;
      e.data('lineWidthView', base * f);
      e.data('lineWidthHlView', (base + 2) * f);
      e.data('fontView', FONT.edge * f);
      e.data('minFontView', cull ? MIN_FONT.edge : 0);
    });
  });
}
