import cytoscape, { type Core } from 'cytoscape';
import elk from 'cytoscape-elk';
import fcose from 'cytoscape-fcose';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { cyHolder } from '../../graph/cyHolder';
import { GroupBodyStore } from '../../graph/groupRegions';
import type { LayoutName } from '../../graph/layouts';
import { graphStyle } from '../../graph/style';
import type { ScaleLimit } from '../../graph/viewScale';
import { ViewScaler } from '../../graph/viewScaler';
import { bindWheelZoom } from '../../graph/wheelZoom';
import { DEFAULT_MIN_ZOOM, FIT_PADDING, MAX_ZOOM, clampPan } from '../../graph/zoomBounds';
import { useGraphStore } from '../../state/store';
import { createGeometrySync } from './geometry';
import type { CanvasHandle } from './handle';

let extensionsRegistered = false;
function registerExtensions() {
  if (extensionsRegistered) return;
  cytoscape.use(fcose);
  cytoscape.use(elk);
  extensionsRegistered = true;
}

const LIMIT_NOTICE: Record<ScaleLimit, string | null> = {
  none: null,
  density: 'Sizing Eased Back — Too Many Names On Screen',
  skeleton: 'Skeleton View — Zoom In For Rooms And Names',
  ceiling: 'Name Sizing At Its 32× Ceiling',
  texture: 'Names Capped — The Longest Would Exceed The Renderer'
};

/**
 * Creates the one Cytoscape instance for this map (the component is mounted
 * with `key={mapId}`, so a new map gets a renderer tuned to its own size —
 * `hideEdgesOnViewport` and `pixelRatio` are construction-only options that
 * can only be picked once, at creation).
 */
function renderProfile(elementCount: number) {
  return {
    hideEdgesOnViewport: elementCount > 12_000,
    textureOnViewport: false,
    motionBlur: false,
    pixelRatio: elementCount > 8_000 ? 1 : undefined
  };
}

export function useCytoscape(
  containerRef: RefObject<HTMLDivElement | null>,
  wrapperRef: RefObject<HTMLDivElement | null>,
  initialElementCount: number
): CanvasHandle | null {
  const [handle, setHandle] = useState<CanvasHandle | null>(null);
  const handleRef = useRef<CanvasHandle | null>(null);

  useEffect(() => {
    if (!containerRef.current || !wrapperRef.current) return;
    registerExtensions();

    const cy = cytoscape({
      container: containerRef.current,
      style: graphStyle,
      elements: [],
      minZoom: DEFAULT_MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      selectionType: 'single',
      boxSelectionEnabled: false,
      ...renderProfile(initialElementCount)
    });

    const settingsRef = { current: useGraphStore.getState().settings };
    const layeringSourceRef = { current: useGraphStore.getState().layout as LayoutName };
    const layoutScaleLockRef: CanvasHandle['layoutScaleLockRef'] = { current: null };
    const cxtStartRef: CanvasHandle['cxtStartRef'] = { current: null };
    const suppressMenuRef = { current: false };
    const connIndexRef: CanvasHandle['connIndexRef'] = { current: new Map() };
    const pendingFitRef: CanvasHandle['pendingFitRef'] = { current: null };

    const scaler = new ViewScaler(cy, settingsRef.current, (limit) => {
      const notice = LIMIT_NOTICE[limit];
      if (notice) useGraphStore.getState().setStatus(notice);
    });
    const groupBodies = new GroupBodyStore(
      cy,
      () => useGraphStore.getState().groups,
      () => useGraphStore.getState().locations
    );

    const h: CanvasHandle = {
      cy,
      scaler,
      settingsRef,
      layeringSourceRef,
      layoutScaleLockRef,
      cxtStartRef,
      suppressMenuRef,
      connIndexRef,
      pendingFitRef,
      groupBodies,
      /* replaced on the next line: the scheduler has to close over the handle */
      sync: () => undefined
    };
    h.sync = createGeometrySync(h);

    handleRef.current = h;
    cyHolder.cy = cy;
    cyHolder.fit = (padding = FIT_PADDING) => h.sync({ fit: padding });

    /* the app owns wheel zooming — see graph/wheelZoom for why Cytoscape's is
       bypassed. Sensitivity is read per event, so Settings applies instantly. */
    const unbindWheel = bindWheelZoom(wrapperRef.current, cy, {
      sensitivity: () => settingsRef.current.scrollSensitivity,
      blocked: () => !!cxtStartRef.current?.moved || cy.nodes(':grabbed').nonempty()
    });

    /* the *live* pan guard: the viewport moved over the content. (The other
       direction — the content moved under the viewport — is `syncGeometry`.) */
    let panClampFrame = 0;
    const onViewportClamp = () => {
      if (panClampFrame) return;
      panClampFrame = requestAnimationFrame(() => {
        panClampFrame = 0;
        if (!layoutScaleLockRef.current) clampPan(cy, settingsRef.current);
      });
    };
    cy.on('viewport', onViewportClamp);

    let lastW = containerRef.current.clientWidth;
    let lastH = containerRef.current.clientHeight;
    const ro = new ResizeObserver(() => {
      const el = containerRef.current;
      if (!el) return;
      const w = el.clientWidth;
      const hgt = el.clientHeight;
      if (!w || !hgt || (w === lastW && hgt === lastH)) return;
      lastW = w;
      lastH = hgt;
      cy.resize();
      /* the zoom floor is a function of the viewport, and a Fit that could not
         be solved while the canvas had no size is latched until exactly here */
      h.sync();
    });
    ro.observe(containerRef.current);

    setHandle(h);

    return () => {
      ro.disconnect();
      unbindWheel();
      cy.off('viewport', onViewportClamp);
      if (panClampFrame) cancelAnimationFrame(panClampFrame);
      scaler.destroy();
      handleRef.current = null;
      cyHolder.fit = null;
      cyHolder.cy = null;
      setHandle(null);
      cy.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return handle;
}
