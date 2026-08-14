import type { Core } from 'cytoscape';
import { invalidateExtent } from '../../graph/extent';
import { applyGroupLayers, applyRoomLayers, computeGroupLayers } from '../../graph/layering';
import { COORDINATE_LAYOUTS, isCoordinateLayout, type LayoutName } from '../../graph/layouts';
import { clampPan, clampZoom, fitToContent, refreshMinZoom } from '../../graph/zoomBounds';
import { useGraphStore } from '../../state/store';
import type { CanvasHandle } from './handle';

export interface GeometrySync {
  /** The element *set* changed: the ViewScaler must re-read every element. */
  rebuild?: boolean;
  /**
   * Re-sort the rooms' draw order as well as the grouping boxes. Default true.
   * A plain drag passes `false`: room order depends only on area / off-plane
   * coordinate, neither of which a drag can change.
   */
  rooms?: boolean;
  /**
   * Frame the whole graph afterwards, with this padding. *Latched*: requested
   * while the canvas still has no size, it happens the moment it gets one.
   */
  fit?: number;
  /** Re-write every visible element's view data (the settings changed). */
  force?: boolean;
}

/** Grouping stack, room stack, and the `boxW`/`boxH` the titles are fitted to. */
function restack(cy: Core, layeringSource: LayoutName, rooms: boolean) {
  const { groups, locations } = useGraphStore.getState();
  const plane = isCoordinateLayout(layeringSource) ? COORDINATE_LAYOUTS[layeringSource] : null;
  const layers = computeGroupLayers(cy, Object.values(groups), Object.values(locations), plane);
  applyGroupLayers(cy, layers);
  if (rooms) applyRoomLayers(cy, locations, plane);
  useGraphStore.getState().setGroupLayers(layers);
}

/**
 * Everything derived from the graph's *geometry* — and nothing else — is
 * recomputed here, in this order, exactly once per trigger:
 *
 *   1. the ViewScaler's element arrays and spatial index
 *   2. the stacking passes: `zLayer`, grouping translucency, `boxW`/`boxH`
 *   2b. every grouping's drawn body: its geometry, its solved title anchor, and
 *       — for a grouping that anchors no room — the leaf node's own position
 *       and size, since nothing else in the pipeline ever sets them
 *   3. the one cached drawn-extent model every bound below solves against
 *   4. the zoom floor — a function of that extent *and* the viewport
 *   5. the viewport itself: a latched Fit, otherwise a zoom/pan clamp
 *   6. the view scale, which reads the zoom step 5 may have just changed
 *   7. a single `mapgraphgeometry` event, after all of the above has settled
 *
 * Before this existed, each call site picked its own subset and its own order,
 * and `extentModel`'s cache was invalidated only by the scrollbars' 150 ms
 * throttle — so a re-layout fitted to, and took its zoom floor from, the
 * *previous* arrangement's extent, and stayed that way until the next reconcile
 * (i.e. until you clicked something). The grouping titles were fitted to
 * `boxW`/`boxH` one pass before `restack()` wrote them, for the same reason.
 *
 * Nothing outside this file may call `refreshMinZoom`, `fitToContent` or
 * `invalidateExtent`.
 */
function syncGeometry(handle: CanvasHandle, opts: GeometrySync) {
  const { cy, scaler, settingsRef, layoutScaleLockRef, pendingFitRef } = handle;
  const settings = settingsRef.current;

  if (opts.fit !== undefined) pendingFitRef.current = opts.fit;

  /* 1 ── what exists, and where it is */
  if (opts.rebuild) scaler.build();
  else scaler.reposition();

  /* 2 ── draw order, grouping translucency, and each grouping's own box */
  restack(cy, handle.layeringSourceRef.current, opts.rooms !== false);

  /* 2b ── the form-fitted bodies: their geometry, their title anchors, and the
     bleed each compound box needs to actually contain what is drawn. Runs after
     restack (it reads zLayer, and overrides boxW/boxH for the form-fitted), and
     before the extent dies below, so every bound solves against the right box. */
  handle.groupBodies.sync();

  /* 3 ── the cached extent model dies here, and is rebuilt exactly once below */
  invalidateExtent(cy);

  /* A layout pins the scale while it solves and re-enters here when it lands; a
     canvas with no size has no viewport to solve a zoom floor against, and the
     ResizeObserver re-enters here the moment it has one. */
  if (!layoutScaleLockRef.current && cy.width() > 0 && cy.height() > 0) {
    /* 4 ── the zoom floor */
    refreshMinZoom(cy, settings);

    /* 5 ── the viewport */
    if (pendingFitRef.current !== null) {
      fitToContent(cy, settings, pendingFitRef.current);
      pendingFitRef.current = null;
    } else {
      clampZoom(cy); // the floor may have risen above where we are standing
      clampPan(cy, settings);
    }
  }

  /* 6 ── the view scale reads the zoom, the boxes and the settings, in that order */
  scaler.flush(opts.force === true);

  /* 7 ── one precise signal for everything that watches geometry */
  cy.emit('mapgraphgeometry');
  cy.forceRender();
}

/**
 * The canvas's single geometry reset, coalesced to once per task. Changing Base
 * Size, for instance, rebuilds every element *and* changes the settings, and
 * those are two independent React effects in one commit: one reset, not two.
 */
export function createGeometrySync(handle: CanvasHandle) {
  let queued: GeometrySync | null = null;

  const run = () => {
    const opts = queued;
    queued = null;
    if (!opts || handle.cy.destroyed()) return;
    syncGeometry(handle, opts);
  };

  return (opts: GeometrySync = {}) => {
    if (queued) {
      queued = {
        rebuild: queued.rebuild || opts.rebuild,
        /* `rooms` is only skipped when *every* caller in the task can skip it */
        rooms: queued.rooms !== false || opts.rooms !== false,
        force: queued.force || opts.force,
        fit: opts.fit ?? queued.fit
      };
      return;
    }
    queued = { ...opts };
    queueMicrotask(run);
  };
}
