import { create } from 'zustand';
import { api } from '../api';
import type { LabelMode } from '../graph/elements';
import type { LayoutName } from '../graph/layouts';
import { arrowsFor, type Direction } from '../graph/model';
import type {
  Connection,
  ContextMenuState,
  GraphMap,
  Location,
  MapSummary,
  Selection
} from '../types';

export type Mode = 'select' | 'add-location' | 'connect';

interface ConnectionDefaults {
  direction: Direction;
  ephemeral: boolean;
  locked: boolean;
}

interface Store {
  /* data */
  maps: MapSummary[];
  map: GraphMap | null;
  mapId: string | null;
  locations: Record<string, Location>;
  connections: Record<string, Connection>;

  /* ui */
  selection: Selection | null;
  mode: Mode;
  pendingSource: string | null;
  contextMenu: ContextMenuState | null;
  layout: LayoutName;
  layoutNonce: number;
  labelMode: LabelMode;
  groupByLayer: boolean;
  connectionDefaults: ConnectionDefaults;
  busy: boolean;
  status: string | null;
  error: string | null;

  pendingPositions: Record<string, { x: number; y: number }>;

  /* actions */
  init: () => Promise<void>;
  refreshMaps: () => Promise<void>;
  openMap: (id: string) => Promise<void>;
  createMap: (name: string) => Promise<void>;
  deleteMap: (id: string) => Promise<void>;
  importMapFile: (file: File) => Promise<void>;
  exportCurrentMap: () => Promise<void>;

  select: (sel: Selection | null) => void;
  selectLocation: (id: string) => void;
  selectConnection: (id: string) => void;
  setMode: (m: Mode) => void;
  setLayout: (l: LayoutName) => void;
  runLayout: () => void;
  setLabelMode: (m: LabelMode) => void;
  setGroupByLayer: (v: boolean) => void;
  setConnectionDefaults: (d: Partial<ConnectionDefaults>) => void;
  setStatus: (s: string | null) => void;
  setError: (e: string | null) => void;
  openContextMenu: (menu: ContextMenuState) => void;
  closeContextMenu: () => void;

  createLocationAt: (x: number, y: number) => Promise<void>;
  updateLocation: (id: string, patch: Partial<Location>) => Promise<void>;
  deleteLocation: (id: string) => Promise<void>;
  toggleVisited: (id: string) => Promise<void>;

  startConnectionFrom: (locationId: string) => void;
  cancelConnect: () => void;
  handleConnectClick: (locationId: string) => Promise<void>;
  createConnection: (sourceId: string, targetId: string) => Promise<void>;
  updateConnection: (id: string, patch: Partial<Connection>) => Promise<void>;
  deleteConnection: (id: string) => Promise<void>;
  deleteSelection: () => Promise<void>;

  queuePosition: (id: string, x: number, y: number) => void;
  flushPositions: () => Promise<void>;
  persistLayoutPositions: (
    positions: Array<{ id: string; x: number; y: number }>
  ) => Promise<void>;
}

const index = <T extends { id: string }>(rows: T[]): Record<string, T> =>
  Object.fromEntries(rows.map((r) => [r.id, r]));

let positionTimer: ReturnType<typeof setTimeout> | null = null;
let statusTimer: ReturnType<typeof setTimeout> | null = null;

export const useGraphStore = create<Store>()((set, get) => {
  const flash = (msg: string) => {
    set({ status: msg });
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => set({ status: null }), 3200);
  };

  const guard = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      set({ busy: true, error: null });
      return await fn();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return undefined;
    } finally {
      set({ busy: false });
    }
  };

  return {
    maps: [],
    map: null,
    mapId: null,
    locations: {},
    connections: {},

    selection: null,
    mode: 'select',
    pendingSource: null,
    contextMenu: null,
    layout: 'elk-layered',
    layoutNonce: 0,
    labelMode: 'names',
    groupByLayer: false,
    connectionDefaults: { direction: 'both', ephemeral: false, locked: false },
    busy: false,
    status: null,
    error: null,
    pendingPositions: {},

    /* ------------------------------------------------------------- boot up */
    init: async () => {
      await get().refreshMaps();
      const first = get().maps[0];
      if (first && !get().mapId) await get().openMap(first.id);
    },

    refreshMaps: async () => {
      await guard(async () => set({ maps: await api.listMaps() }));
    },

    openMap: async (id) => {
      await guard(async () => {
        const graph = await api.getGraph(id);
        const allPositioned =
          graph.locations.length > 0 &&
          graph.locations.every((l) => l.x !== null && l.y !== null);
        set((s) => ({
          mapId: id,
          map: graph.map,
          locations: index(graph.locations),
          connections: index(graph.connections),
          /* a clean slate: no stale selection, highlight, drag or menu state */
          selection: null,
          pendingSource: null,
          contextMenu: null,
          mode: 'select',
          pendingPositions: {},
          layout: allPositioned ? 'preset' : s.layout,
          layoutNonce: s.layoutNonce + 1
        }));
      });
    },

    createMap: async (name) => {
      const created = await guard(() => api.createMap(name));
      if (!created) return;
      await get().refreshMaps();
      await get().openMap(created.id);
      flash(`Created Map "${created.name}"`);
    },

    deleteMap: async (id) => {
      await guard(() => api.deleteMap(id));
      if (get().mapId === id) {
        set({
          mapId: null,
          map: null,
          locations: {},
          connections: {},
          selection: null,
          pendingPositions: {}
        });
      }
      await get().refreshMaps();
      flash('Map Deleted');
    },

    importMapFile: async (file) => {
      await guard(async () => {
        const payload = JSON.parse(await file.text());
        const graph = await api.importMap(payload);
        await get().refreshMaps();
        await get().openMap(graph.map.id);
        flash('Map Imported');
      });
    },

    exportCurrentMap: async () => {
      const { mapId, map } = get();
      if (!mapId) return;
      await guard(async () => {
        const data = await api.exportMap(mapId);
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${(map?.name ?? 'map').replace(/[^\w.-]+/g, '_')}.json`;
        a.click();
        URL.revokeObjectURL(url);
      });
    },

    /* ------------------------------------------------------------ ui state */
    select: (sel) => set({ selection: sel }),
    selectLocation: (id) => set({ selection: { type: 'location', id } }),
    selectConnection: (id) => set({ selection: { type: 'connection', id } }),
    setMode: (mode) =>
      set({ mode, pendingSource: mode === 'connect' ? get().pendingSource : null }),
    setLayout: (layout) => set({ layout }),
    runLayout: () => set((s) => ({ layoutNonce: s.layoutNonce + 1 })),
    setLabelMode: (labelMode) => set({ labelMode }),
    setGroupByLayer: (groupByLayer) => set({ groupByLayer }),
    setConnectionDefaults: (d) =>
      set((s) => ({ connectionDefaults: { ...s.connectionDefaults, ...d } })),
    setStatus: (status) => set({ status }),
    setError: (error) => set({ error }),
    openContextMenu: (contextMenu) => set({ contextMenu }),
    closeContextMenu: () => set({ contextMenu: null }),

    /* ----------------------------------------------------------- locations */
    createLocationAt: async (x, y) => {
      const { mapId } = get();
      if (!mapId) return;
      const created = await guard(() =>
        api.createLocation(mapId, { name: 'New Location', x, y })
      );
      if (!created) return;
      set((s) => ({
        locations: { ...s.locations, [created.id]: created },
        selection: { type: 'location', id: created.id },
        mode: 'select',
        contextMenu: null
      }));
      flash('Location Created — Rename It In The Inspector');
    },

    updateLocation: async (id, patch) => {
      const updated = await guard(() => api.updateLocation(id, patch));
      if (!updated) return;
      set((s) => ({ locations: { ...s.locations, [id]: updated } }));
    },

    deleteLocation: async (id) => {
      await guard(() => api.deleteLocation(id));
      if (get().error) return;
      set((s) => {
        const locations = { ...s.locations };
        delete locations[id];
        const connections: Record<string, Connection> = {};
        for (const [key, c] of Object.entries(s.connections)) {
          if (c.sourceId === id || c.targetId === id) continue;
          connections[key] = c.requires.includes(id)
            ? { ...c, requires: c.requires.filter((r) => r !== id) }
            : c;
        }
        return { locations, connections, selection: null, contextMenu: null };
      });
      flash('Location Deleted');
    },

    toggleVisited: async (id) => {
      const loc = get().locations[id];
      if (!loc) return;
      await get().updateLocation(id, { visited: !loc.visited });
    },

    /* --------------------------------------------------------- connections */
    startConnectionFrom: (locationId) =>
      set({ mode: 'connect', pendingSource: locationId, contextMenu: null }),

    cancelConnect: () => set({ mode: 'select', pendingSource: null }),

    handleConnectClick: async (locationId) => {
      const { pendingSource } = get();
      if (!pendingSource) {
        set({ pendingSource: locationId });
        flash('Now Pick The Destination Location');
        return;
      }
      if (pendingSource === locationId) {
        set({ pendingSource: null, mode: 'select' });
        flash('Connection Cancelled');
        return;
      }
      await get().createConnection(pendingSource, locationId);
      set({ pendingSource: null, mode: 'select' });
    },

    createConnection: async (sourceId, targetId) => {
      const { mapId, connectionDefaults } = get();
      if (!mapId) return;
      const { direction, ...rest } = connectionDefaults;
      const created = await guard(() =>
        api.createConnection(mapId, {
          sourceId,
          targetId,
          ...rest,
          ...arrowsFor(direction)
        })
      );
      if (!created) return;
      set((s) => ({
        connections: { ...s.connections, [created.id]: created },
        selection: { type: 'connection', id: created.id }
      }));
      flash('Connection Created');
    },

    updateConnection: async (id, patch) => {
      const updated = await guard(() => api.updateConnection(id, patch));
      if (!updated) return;
      set((s) => ({ connections: { ...s.connections, [id]: updated } }));
    },

    deleteConnection: async (id) => {
      await guard(() => api.deleteConnection(id));
      if (get().error) return;
      set((s) => {
        const connections = { ...s.connections };
        delete connections[id];
        return { connections, selection: null, contextMenu: null };
      });
      flash('Connection Deleted');
    },

    deleteSelection: async () => {
      const sel = get().selection;
      if (!sel) return;
      if (sel.type === 'location') await get().deleteLocation(sel.id);
      else await get().deleteConnection(sel.id);
    },

    /* ------------------------------------------------------- layout saving */
    queuePosition: (id, x, y) => {
      set((s) => ({ pendingPositions: { ...s.pendingPositions, [id]: { x, y } } }));
      if (positionTimer) clearTimeout(positionTimer);
      positionTimer = setTimeout(() => void get().flushPositions(), 600);
    },

    flushPositions: async () => {
      const { pendingPositions, mapId, locations } = get();
      const entries = Object.entries(pendingPositions).filter(([id]) => locations[id]);
      if (!mapId || entries.length === 0) {
        if (Object.keys(pendingPositions).length) set({ pendingPositions: {} });
        return;
      }
      try {
        await api.savePositions(
          mapId,
          entries.map(([id, p]) => ({ id, x: p.x, y: p.y }))
        );
        const patched = { ...get().locations };
        for (const [id, p] of entries) {
          if (patched[id]) patched[id] = { ...patched[id], x: p.x, y: p.y };
        }
        set({ locations: patched, pendingPositions: {} });
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      }
    },

    persistLayoutPositions: async (positions) => {
      const { mapId } = get();
      if (!mapId || !positions.length) return;
      try {
        await api.savePositions(mapId, positions);
        const patched = { ...get().locations };
        for (const p of positions) {
          if (patched[p.id]) patched[p.id] = { ...patched[p.id], x: p.x, y: p.y };
        }
        set({ locations: patched, layout: 'preset', pendingPositions: {} });
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  };
});
