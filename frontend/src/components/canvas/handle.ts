import type { Core } from 'cytoscape';
import type { MutableRefObject } from 'react';
import type { ConnectionIndex } from '../../graph/highlight';
import type { GroupBodyStore } from '../../graph/groupRegions';
import type { LayoutName } from '../../graph/layouts';
import type { Settings } from '../../state/settings';
import type { ViewScaler } from '../../graph/viewScaler';
import type { GeometrySync } from './geometry';

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
  /** A Fit that could not be solved yet (no viewport), held until it can be. */
  pendingFitRef: MutableRefObject<number | null>;
  /** The one owner of every grouping's drawn body — geometry, titles, bleed. */
  groupBodies: GroupBodyStore;
  /**
   * The one and only place anything derived from the graph's geometry is
   * recomputed — the scaler's index, the stacking passes, the extent model, the
   * zoom floor, the viewport and the view scale. Coalesced: every caller in one
   * task produces exactly one reset.
   */
  sync: (opts?: GeometrySync) => void;
}
