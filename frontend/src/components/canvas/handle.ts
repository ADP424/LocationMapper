import type { Core } from 'cytoscape';
import type { MutableRefObject } from 'react';
import type { ConnectionIndex } from '../../graph/highlight';
import type { LayoutName } from '../../graph/layouts';
import type { Settings } from '../../state/settings';
import type { ViewScaler } from '../../graph/viewScaler';

/** Everything the canvas hooks share. Created once per map by `useCytoscape`. */
export interface CanvasHandle {
  cy: Core;
  scaler: ViewScaler;
  settingsRef: MutableRefObject<Settings>;
  /**
   * Which layout produced the on-screen arrangement. Not the picker value:
   * persisting a layout flips the picker to "Saved Positions", but a
   * coordinate arrangement must keep its coordinate-based grouping stack.
   */
  layeringSourceRef: MutableRefObject<LayoutName>;
  /** Held by the layout currently being solved, so every effect agrees on
   *  base geometry. A token rather than a boolean: a cancelled layout can
   *  still emit `layoutstop` after its successor has taken the lock. */
  layoutScaleLockRef: MutableRefObject<object | null>;
  /** Right-drag marquee bookkeeping, shared with the context-menu suppressor. */
  cxtStartRef: MutableRefObject<{ x: number; y: number; moved: boolean } | null>;
  suppressMenuRef: MutableRefObject<boolean>;
  /** connectionId -> the elements that draw it. Rebuilt on structural change. */
  connIndexRef: MutableRefObject<ConnectionIndex>;
  /** Frame the whole map, then let the scaler re-settle against the new viewport. */
  fitAndRescale: (padding: number) => void;
  /** Recompute the grouping stack and push it onto the graph. */
  restack: (opts?: { rooms?: boolean }) => void;
}
