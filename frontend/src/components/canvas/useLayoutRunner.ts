import type { Core } from 'cytoscape';
import { useEffect } from 'react';
import { computeCoordinateLayout } from '../../graph/coordinateLayout';
import { parsePortalId } from '../../graph/elements';
import { computeGroupedLayout } from '../../graph/groupLayout';
import { COORDINATE_LAYOUTS, computeMetrics, isCoordinateLayout, layoutOptions, type LayoutName } from '../../graph/layouts';
import { layoutSpan } from '../../graph/viewScale';
import { useGraphStore } from '../../state/store';
import type { PortalOffset } from '../../types';
import type { CanvasHandle } from './handle';

/** A layout that never reports back must not leave the canvas locked to base scale. */
const LAYOUT_WATCHDOG_MS = 20_000;

/** A layout moves stubs as plain nodes; their offset is the thing we persist,
 *  so recompute it from where they ended up. */
function rebaseStubOffsets(cy: Core) {
  cy.batch(() => {
    cy.nodes('.portal').forEach((p) => {
      const anchor = cy.getElementById(p.data('anchorId'));
      if (anchor.empty()) return;
      const a = anchor.position();
      const s = p.position();
      p.data('offsetX', s.x - a.x);
      p.data('offsetY', s.y - a.y);
    });
  });
}

function snapshot(cy: Core) {
  const positions = cy.nodes('.location').map((n) => ({ id: n.id(), x: n.position().x, y: n.position().y }));
  const portalOffsets: PortalOffset[] = [];
  cy.nodes('.portal').forEach((p) => {
    const anchor = cy.getElementById(p.data('anchorId'));
    const parsed = parsePortalId(p.id());
    if (anchor.empty() || !parsed) return;
    portalOffsets.push({
      connectionId: parsed.connectionId,
      side: parsed.side,
      dx: p.position().x - anchor.position().x,
      dy: p.position().y - anchor.position().y
    });
  });
  return { positions, portalOffsets };
}

export function useLayoutRunner(handle: CanvasHandle | null, layout: LayoutName, layoutNonce: number, mapId: string | null) {
  useEffect(() => {
    if (!handle) return;
    const { cy, scaler, layeringSourceRef, layoutScaleLockRef, settingsRef } = handle;
    if (cy.nodes().length === 0) return;
    let cancelled = false;
    layeringSourceRef.current = layout;

    const metrics = computeMetrics(
      cy.edges().map((e) => (e.data('labelWidth') as number) ?? 0),
      /* footprints: a name plate is a spacing constraint now, same as the box */
      cy.nodes('.location, .portal').map((n) => {
        const s = layoutSpan(n);
        return Math.max(s.w, s.h);
      }),
      settingsRef.current.baseScale
    );

    const finish = (padding: number, persist = true) => {
      scaler.reposition();
      handle.restack();
      handle.fitAndRescale(padding);
      cy.forceRender();
      if (!persist) return;
      const snap = snapshot(cy);
      void useGraphStore.getState().persistLayoutPositions(snap.positions, snap.portalOffsets);
    };

    if (layout === 'preset') {
      finish(60, false);
      return;
    }

    /* ------------------------------------------- coordinate grid layouts */
    if (isCoordinateLayout(layout)) {
      const plane = COORDINATE_LAYOUTS[layout];
      const state = useGraphStore.getState();
      const result = computeCoordinateLayout(cy, plane, {
        locations: state.locations,
        connections: state.connections
      });
      if (!result.positions.size) return;

      cy.batch(() => {
        result.positions.forEach((p, id) => {
          const n = cy.getElementById(id);
          if (n.nonempty()) n.position(p);
        });
      });
      rebaseStubOffsets(cy);
      finish(70); // off-plane coordinate order (restack reads layeringSourceRef)

      useGraphStore
        .getState()
        .setStatus(
          [
            `${plane.toUpperCase()} Grid`,
            `${result.unit}px Per Coordinate`,
            `${result.placedByCoords} By Coordinates`,
            result.placedByNeighbours ? `${result.placedByNeighbours} By Connections` : '',
            result.seeded ? `${result.seeded} Unconnected` : ''
          ]
            .filter(Boolean)
            .join(' · ')
        );
      return;
    }

    const hasGroups = cy.nodes('.group').nonempty();

    if (!hasGroups) {
      /* Solve against base geometry: the arrangement must depend on the rooms'
         own footprints, never on the current name compensation (which would
         otherwise inflate every plate and make each re-layout drift larger). */
      const token = {};
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      const release = () => {
        if (watchdog) {
          clearTimeout(watchdog);
          watchdog = null;
        }
        /* only the run that took the lock may hand it back: a cancelled layout
           can still emit `layoutstop` after its successor has taken it */
        if (layoutScaleLockRef.current !== token) return;
        layoutScaleLockRef.current = null;
        unlockGeometry();
      };
      layoutScaleLockRef.current = token;
      /* engines measure labels (`nodeDimensionsIncludeLabels`): names must be
         at Base Size — never compensated — while they solve */
      const unlockGeometry = scaler.lockForLayout();
      /* …and a layout that never reports back must not freeze the compensation,
         which looks exactly like the wheel suddenly got more sensitive */
      watchdog = setTimeout(release, LAYOUT_WATCHDOG_MS);

      const run = cy.layout(layoutOptions(layout, metrics));
      run.one('layoutstop', () => {
        release();
        if (cancelled) return;
        rebaseStubOffsets(cy);
        finish(60); // footprints are final now that every room has landed
      });
      run.run();
      return () => {
        cancelled = true;
        run.stop();
        release();
      };
    }

    (async () => {
      const positions = await computeGroupedLayout(cy, layout, settingsRef.current.baseScale);
      if (cancelled || !positions.size) return;
      cy.batch(() => {
        positions.forEach((p, id) => {
          const n = cy.getElementById(id);
          if (n.nonempty() && !n.hasClass('group')) n.position(p);
        });
      });
      rebaseStubOffsets(cy);
      finish(70);
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, layoutNonce, mapId]);
}
