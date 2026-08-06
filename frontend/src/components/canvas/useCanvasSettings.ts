import { useEffect } from 'react';
import { invalidateExtent } from '../../graph/extent';
import { refreshMinZoom } from '../../graph/zoomBounds';
import type { Settings } from '../../state/settings';
import type { CanvasHandle } from './handle';

/** Pushes a settings change into the live canvas without recreating anything. */
export function useCanvasSettings(handle: CanvasHandle | null, settings: Settings) {
  useEffect(() => {
    if (!handle) return;
    handle.settingsRef.current = settings;
    /* a running layout owns the geometry — re-applying scale here would clamp
       the unclamped pass it is solving against */
    if (!handle.layoutScaleLockRef.current) handle.scaler.setSettings(settings);
    invalidateExtent(handle.cy);
    refreshMinZoom(handle.cy, settings, true);
    handle.cy.forceRender();
  }, [handle, settings]);
}
