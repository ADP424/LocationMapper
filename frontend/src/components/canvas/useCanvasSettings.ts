import { useEffect } from 'react';
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
    /* Base Size, compensation and the skeleton all move the drawn extent, so
       every bound is a function of the settings. One reset, in one place. */
    handle.sync({ force: true });
  }, [handle, settings]);
}
