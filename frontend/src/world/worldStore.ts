/**
 * The open Minecraft world, as a store of its own.
 *
 * Kept apart from `useGraphStore` on purpose: nothing here is part of the map.
 * The graph store is the thing that talks to the API and gets exported, and a
 * folder path on someone's laptop has no business in it. The two meet only in
 * the 3D canvas, which reads from both.
 */

import { create } from 'zustand';
import type { MarkerMode } from './scene/graphData';
import {
  fromDirectoryInput,
  fromLocalPath,
  pickWorldDirectory,
  type DimensionRef,
  type WorldSource
} from './source/worldSource';
import { DEFAULT_WORLD_PREF, loadWorldPref, saveWorldPref, type WorldPref } from './worldPrefs';

interface WorldState {
  /** The map these preferences belong to, so a map switch reloads them. */
  mapId: string | null;
  source: WorldSource | null;
  loading: boolean;
  error: string | null;
  /** Remembered even before a world is open, so the choice survives a reload. */
  root: string;
  dimensionId: string;
  renderDistance: number;
  markerMode: MarkerMode;
  markerDistance: number;
  labelDistance: number;

  /** Load the preferences for a map. Cheap enough to call on every render. */
  bind: (mapId: string | null) => void;
  openPath: (root: string) => Promise<void>;
  openPicker: () => Promise<void>;
  openDirectoryInput: (files: FileList) => Promise<void>;
  close: () => void;
  setDimensionId: (id: string) => void;
  setRenderDistance: (chunks: number) => void;
  setMarkerMode: (mode: MarkerMode) => void;
  setMarkerDistance: (blocks: number) => void;
  setLabelDistance: (blocks: number) => void;
  setError: (message: string | null) => void;
}

export const useWorldStore = create<WorldState>()((set, get) => {
  const remember = (patch: Partial<WorldPref>) => {
    const { mapId } = get();
    if (mapId) saveWorldPref(mapId, patch);
  };

  /**
   * Pick the dimension to show once a world is open: the remembered one when it
   * is still there, otherwise the first (which `worldSource` has already sorted
   * with the overworld in front).
   */
  const chooseDimension = (source: WorldSource, wanted: string): string => {
    if (source.dimensions.some((d) => d.id === wanted)) return wanted;
    return source.dimensions[0]?.id ?? wanted;
  };

  const open = async (load: () => Promise<WorldSource>, root: string) => {
    set({ loading: true, error: null });
    try {
      const source = await load();
      const dimensionId = chooseDimension(source, get().dimensionId);
      set({ source, dimensionId, root, loading: false });
      remember({ root, dimensionId });
      if (source.dimensions.length === 0) {
        set({
          error:
            'No region files in that folder. Pick the world folder itself — the one ' +
            'containing level.dat and region/.'
        });
      }
    } catch (e) {
      /* Dismissing the folder picker is not an error worth shouting about. */
      const aborted = e instanceof DOMException && e.name === 'AbortError';
      set({
        loading: false,
        error: aborted ? null : e instanceof Error ? e.message : String(e)
      });
    }
  };

  return {
    mapId: null,
    source: null,
    loading: false,
    error: null,
    root: DEFAULT_WORLD_PREF.root,
    dimensionId: DEFAULT_WORLD_PREF.dimensionId,
    renderDistance: DEFAULT_WORLD_PREF.renderDistance,
    markerMode: DEFAULT_WORLD_PREF.markerMode,
    markerDistance: DEFAULT_WORLD_PREF.markerDistance,
    labelDistance: DEFAULT_WORLD_PREF.labelDistance,

    bind: (mapId) => {
      if (mapId === get().mapId) return;
      if (!mapId) {
        set({ mapId: null, source: null, error: null, ...DEFAULT_WORLD_PREF });
        return;
      }
      /* A different map may point at a different world, so whatever is loaded
         is no longer the right thing to be showing. */
      set({ mapId, source: null, error: null, loading: false, ...loadWorldPref(mapId) });
    },

    openPath: (root) => open(() => fromLocalPath(root), root),
    openPicker: () => open(pickWorldDirectory, get().root),
    openDirectoryInput: (files) => open(() => fromDirectoryInput(files), get().root),

    close: () => set({ source: null, error: null }),

    setDimensionId: (dimensionId) => {
      set({ dimensionId });
      remember({ dimensionId });
    },

    setRenderDistance: (renderDistance) => {
      set({ renderDistance });
      remember({ renderDistance });
    },

    setMarkerMode: (markerMode) => {
      set({ markerMode });
      remember({ markerMode });
    },

    setMarkerDistance: (markerDistance) => {
      set({ markerDistance });
      remember({ markerDistance });
    },

    setLabelDistance: (labelDistance) => {
      set({ labelDistance });
      remember({ labelDistance });
    },

    setError: (error) => set({ error })
  };
});

/** The dimension currently selected, if the open world has it. */
export function currentDimension(state: WorldState): DimensionRef | null {
  return state.source?.dimensions.find((d) => d.id === state.dimensionId) ?? null;
}
