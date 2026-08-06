import { create } from 'zustand';
import { api } from '../api';
import { parsePortalId, type LabelMode } from '../graph/elements';
import { descendantGroupIds } from '../graph/groups';
import type { GroupLayer } from '../graph/layering';
import type { LayoutName } from '../graph/layouts';
import { arrowsFor, type Direction } from '../graph/model';
import {
  AUTO_PLAN_LIMIT_MS,
  MAX_PLANNER_STATES,
  type AxisToggles,
  type PlannerInput,
  type RouteMode,
  type RoutePlan
} from '../graph/pathfinding';
import { runPlanner, type PlannerRun } from '../graph/plannerClient';
import { DEFAULT_SETTINGS, loadSettings, normaliseSettings, saveSettings, type Settings } from './settings';
import type {
  Connection,
  ConnectionLabel,
  ContextMenuState,
  GraphMap,
  Group,
  Location,
  LocationLabel,
  MapSummary,
  PortalOffset,
  Selection
} from '../types';

export type Mode = 'select' | 'add-location' | 'connect';

interface ConnectionDefaults {
  direction: Direction;
  ephemeral: boolean;
  locked: boolean;
}

export interface TripState {
  waypoints: string[];
  mode: RouteMode;
  axes: AxisToggles;
  /** Re-solve automatically when the trip or the map changes. */
  autoPlan: boolean;
  plan: RoutePlan | null;
  /** The plan predates the current map/options. */
  stale: boolean;
  running: boolean;
  progress: { states: number; elapsedMs: number } | null;
}

const EMPTY_TRIP: TripState = {
  waypoints: [],
  mode: 'stops',
  axes: { x: true, y: true, z: true },
  autoPlan: true,
  plan: null,
  stale: false,
  running: false,
  progress: null
};

/** The in-flight planner run, if any. */
let plannerRun: PlannerRun | null = null;

interface Store {
  maps: MapSummary[];
  map: GraphMap | null;
  mapId: string | null;
  groups: Record<string, Group>;
  /** Stacking order of the groupings, recomputed after every arrangement. */
  groupLayers: Record<string, GroupLayer>;
  locationLabels: Record<string, LocationLabel>;
  connectionLabels: Record<string, ConnectionLabel>;
  locations: Record<string, Location>;
  connections: Record<string, Connection>;

  selection: Selection | null;
  /** Ids of rooms picked with the right-drag marquee (never groupings). */
  multiSelect: string[];
  mode: Mode;
  pendingSource: string | null;
  contextMenu: ContextMenuState | null;
  layout: LayoutName;
  layoutNonce: number;
  labelMode: LabelMode;
  connectionDefaults: ConnectionDefaults;
  busy: boolean;
  status: string | null;
  error: string | null;
  settings: Settings;
  settingsOpen: boolean;
  trip: TripState;

  pendingPositions: Record<string, { x: number; y: number }>;
  /** Unsaved stub offsets, keyed by portal node id. */
  pendingPortalOffsets: Record<string, { dx: number; dy: number }>;

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
  selectGroup: (id: string) => void;
  selectLocationLabel: (id: string) => void;
  selectConnectionLabel: (id: string) => void;
  setMultiSelect: (ids: string[]) => void;
  setMode: (m: Mode) => void;
  setLayout: (l: LayoutName) => void;
  runLayout: () => void;
  setLabelMode: (m: LabelMode) => void;
  setGroupLayers: (layers: Record<string, GroupLayer>) => void;
  setConnectionDefaults: (d: Partial<ConnectionDefaults>) => void;
  setStatus: (s: string | null) => void;
  setError: (e: string | null) => void;
  setSettings: (patch: Partial<Settings>) => void;
  resetSettings: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  openContextMenu: (menu: ContextMenuState) => void;
  closeContextMenu: () => void;

  addWaypoint: (locationId: string) => void;
  removeWaypoint: (index: number) => void;
  moveWaypoint: (index: number, delta: number) => void;
  setTripMode: (mode: RouteMode) => void;
  setTripAxis: (axis: keyof AxisToggles, on: boolean) => void;
  setAutoPlan: (on: boolean) => void;
  startPlan: () => Promise<void>;
  cancelPlan: () => void;
  markTripStale: () => void;
  clearTrip: () => void;
  resetAllVisited: () => Promise<void>;

  createLocationAt: (x: number, y: number, groupId?: string | null) => Promise<void>;
  updateLocation: (id: string, patch: Partial<Location>) => Promise<void>;
  bulkUpdateLocations: (ids: string[], patch: Partial<Location>) => Promise<void>;
  deleteLocation: (id: string) => Promise<void>;
  deleteLocations: (ids: string[]) => Promise<void>;
  toggleVisited: (id: string) => Promise<void>;

  createGroupFrom: (locationIds: string[]) => Promise<void>;
  updateGroup: (id: string, patch: Partial<Group>) => Promise<void>;
  deleteGroup: (id: string) => Promise<void>;
  ungroupAll: (id: string) => Promise<void>;
  setLocationGroup: (locationId: string, groupId: string | null) => Promise<void>;
  setGroupParent: (groupId: string, parentId: string | null) => Promise<void>;

  createLocationLabel: (name: string) => Promise<void>;
  updateLocationLabel: (id: string, patch: Partial<LocationLabel>) => Promise<void>;
  deleteLocationLabel: (id: string) => Promise<void>;
  applyLocationLabelToAll: (id: string) => Promise<void>;
  assignLocationLabel: (locationId: string, labelId: string) => Promise<void>;
  unassignLocationLabel: (locationId: string, labelId: string) => Promise<void>;
  applyLocationLabelStyling: (locationId: string, labelId: string) => Promise<void>;
  bulkAssignLocationLabel: (locationIds: string[], labelId: string) => Promise<void>;

  createConnectionLabel: (name: string) => Promise<void>;
  updateConnectionLabel: (id: string, patch: Partial<ConnectionLabel>) => Promise<void>;
  deleteConnectionLabel: (id: string) => Promise<void>;
  applyConnectionLabelToAll: (id: string) => Promise<void>;
  assignConnectionLabel: (connectionId: string, labelId: string) => Promise<void>;
  unassignConnectionLabel: (connectionId: string, labelId: string) => Promise<void>;
  applyConnectionLabelStyling: (connectionId: string, labelId: string) => Promise<void>;

  startConnectionFrom: (locationId: string) => void;
  cancelConnect: () => void;
  handleConnectClick: (locationId: string) => Promise<void>;
  createConnection: (sourceId: string, targetId: string) => Promise<void>;
  updateConnection: (id: string, patch: Partial<Connection>) => Promise<void>;
  deleteConnection: (id: string) => Promise<void>;
  deleteSelection: () => Promise<void>;

  queuePosition: (id: string, x: number, y: number) => void;
  queuePositions: (list: Array<{ id: string; x: number; y: number }>) => void;
  queuePortalOffset: (portalId: string, dx: number, dy: number) => void;
  flushPositions: () => Promise<void>;
  persistLayoutPositions: (
    positions: Array<{ id: string; x: number; y: number }>,
    portalOffsets: PortalOffset[]
  ) => Promise<void>;
}

const index = <T extends { id: string }>(rows: T[]): Record<string, T> =>
  Object.fromEntries(rows.map((r) => [r.id, r]));

function mergePositions(
  locations: Record<string, Location>,
  list: Array<{ id: string; x: number; y: number }>
) {
  if (!list.length) return locations;
  const next = { ...locations };
  for (const p of list) if (next[p.id]) next[p.id] = { ...next[p.id], x: p.x, y: p.y };
  return next;
}

function mergePortalOffsets(
  connections: Record<string, Connection>,
  list: PortalOffset[]
) {
  if (!list.length) return connections;
  const next = { ...connections };
  for (const o of list) {
    const c = next[o.connectionId];
    if (!c) continue;
    next[c.id] =
      o.side === 'out' ? { ...c, outDx: o.dx, outDy: o.dy } : { ...c, inDx: o.dx, inDy: o.dy };
  }
  return next;
}

let positionTimer: ReturnType<typeof setTimeout> | null = null;
let statusTimer: ReturnType<typeof setTimeout> | null = null;
let tripTimer: ReturnType<typeof setTimeout> | null = null;
const TRIP_DEBOUNCE_MS = 250;

export const useGraphStore = create<Store>()((set, get) => {
  const flash = (msg: string) => {
    set({ status: msg });
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => set({ status: null }), 3600);
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

  const cancelPositionFlush = () => {
    if (positionTimer) clearTimeout(positionTimer);
    positionTimer = null;
  };
  const cancelTripDebounce = () => {
    if (tripTimer) clearTimeout(tripTimer);
    tripTimer = null;
  };

  /**
   * Like `guard`, but drops the result if the user switched maps while the
   * request was in flight — otherwise a slow response writes stale rows into
   * the newly opened map's state.
   */
  const guardScoped = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    const mapAtStart = get().mapId;
    const result = await guard(fn);
    if (result === undefined) return undefined;
    if (get().mapId !== mapAtStart) return undefined;
    return result;
  };

  /** Apply whatever succeeded; report whatever didn't. */
  const settleBatch = async <T>(jobs: Array<Promise<T>>) => {
    const results = await Promise.allSettled(jobs);
    const ok = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    const failed = results.length - ok.length;
    const firstError = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    return { ok, failed, total: results.length, firstError };
  };

  const afterStructureChange = () => {
    if (get().layout === 'preset') flash('Grouping Updated — Press Re-Layout To Rearrange');
    else set((s) => ({ layoutNonce: s.layoutNonce + 1 }));
  };

  return {
    maps: [],
    map: null,
    mapId: null,
    groups: {},
    groupLayers: {},
    locationLabels: {},
    connectionLabels: {},
    locations: {},
    connections: {},

    selection: null,
    multiSelect: [],
    mode: 'select',
    pendingSource: null,
    contextMenu: null,
    layout: 'elk-layered',
    layoutNonce: 0,
    labelMode: 'names',
    connectionDefaults: { direction: 'both', ephemeral: false, locked: false },
    busy: false,
    status: null,
    error: null,
    settings: loadSettings(),
    settingsOpen: false,
    trip: { ...EMPTY_TRIP },
    pendingPositions: {},
    pendingPortalOffsets: {},

    init: async () => {
      await get().refreshMaps();
      const first = get().maps[0];
      if (first && !get().mapId) await get().openMap(first.id);
    },

    refreshMaps: async () => {
      await guard(async () => set({ maps: await api.listMaps() }));
    },

    openMap: async (id) => {
      /* a drag within the debounce window must not be lost */
      await get().flushPositions();
      cancelPositionFlush();
      cancelTripDebounce();
      plannerRun?.discard();
      plannerRun = null;
      await guard(async () => {
        const graph = await api.getGraph(id);
        const allPositioned =
          graph.locations.length > 0 && graph.locations.every((l) => l.x !== null && l.y !== null);
        set((s) => ({
          mapId: id,
          map: graph.map,
          groups: index(graph.groups),
          groupLayers: {},
          locationLabels: index(graph.locationLabels),
          connectionLabels: index(graph.connectionLabels),
          locations: index(graph.locations),
          connections: index(graph.connections),
          selection: null,
          multiSelect: [],
          pendingSource: null,
          contextMenu: null,
          mode: 'select',
          pendingPositions: {},
          pendingPortalOffsets: {},
          layout: allPositioned ? 'preset' : s.layout,
          layoutNonce: s.layoutNonce + 1,
          trip: { ...EMPTY_TRIP, mode: s.trip.mode, axes: s.trip.axes, autoPlan: s.trip.autoPlan }
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
      await get().flushPositions();
      cancelPositionFlush();
      await guard(() => api.deleteMap(id));
      if (get().mapId === id) {
        set({
          mapId: null,
          map: null,
          groups: {},
          groupLayers: {},
          locationLabels: {},
          connectionLabels: {},
          locations: {},
          connections: {},
          selection: null,
          multiSelect: [],
          pendingPositions: {},
          pendingPortalOffsets: {},
          trip: { ...EMPTY_TRIP }
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
        const count = graph.warnings?.length ?? 0;
        if (count) {
          set({ error: `Imported With ${count} Warning${count === 1 ? '' : 's'}: ${graph.warnings![0]}` });
          flash(`Map Imported With ${count} Warning${count === 1 ? '' : 's'}`);
        } else flash('Map Imported');
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

    select: (sel) => set({ selection: sel, multiSelect: [] }),
    selectLocation: (id) => set({ selection: { type: 'location', id }, multiSelect: [] }),
    selectConnection: (id) => set({ selection: { type: 'connection', id }, multiSelect: [] }),
    selectGroup: (id) => set({ selection: { type: 'group', id }, multiSelect: [] }),
    selectLocationLabel: (id) => set({ selection: { type: 'location-label', id }, multiSelect: [] }),
    selectConnectionLabel: (id) =>
      set({ selection: { type: 'connection-label', id }, multiSelect: [] }),

    setMultiSelect: (ids) => {
      if (ids.length === 0) set({ multiSelect: [], selection: null });
      else if (ids.length === 1) set({ multiSelect: [], selection: { type: 'location', id: ids[0] } });
      else set({ multiSelect: ids, selection: null, contextMenu: null });
    },

    setMode: (mode) =>
      set({ mode, pendingSource: mode === 'connect' ? get().pendingSource : null }),
    setLayout: (layout) => set({ layout }),
    runLayout: () => set((s) => ({ layoutNonce: s.layoutNonce + 1 })),
    setLabelMode: (labelMode) => set({ labelMode }),
    /** Ignore identical results: this runs on every edit, drag and layout. */
    setGroupLayers: (layers) => {
      const prev = get().groupLayers;
      const ids = Object.keys(layers);
      const unchanged =
        ids.length === Object.keys(prev).length &&
        ids.every((id) => prev[id]?.order === layers[id].order && prev[id]?.note === layers[id].note);
      if (!unchanged) set({ groupLayers: layers });
    },
    setConnectionDefaults: (d) =>
      set((s) => ({ connectionDefaults: { ...s.connectionDefaults, ...d } })),
    setStatus: (status) => {
      set({ status });
      if (statusTimer) clearTimeout(statusTimer);
      if (status) statusTimer = setTimeout(() => set({ status: null }), 3600);
    },
    setError: (error) => set({ error }),

    setSettings: (patch) => {
      const previous = get().settings;
      const next = normaliseSettings({ ...previous, ...patch });
      saveSettings(next);
      set({ settings: next });
      /* layouts space for the boxes they will draw, so the old positions are now
         either too tight or too loose */
      if (next.baseScale !== previous.baseScale) {
        flash('Base Size Changed — Re-Layout To Respace The Map');
      }
    },
    resetSettings: () => {
      saveSettings(DEFAULT_SETTINGS);
      set({ settings: { ...DEFAULT_SETTINGS } });
    },
    openSettings: () => set({ settingsOpen: true }),
    closeSettings: () => set({ settingsOpen: false }),
    openContextMenu: (contextMenu) => set({ contextMenu }),
    closeContextMenu: () => set({ contextMenu: null }),

    /* ------------------------------------------------------ trip planner */
    addWaypoint: (locationId) => {
      set((s) => ({ trip: { ...s.trip, waypoints: [...s.trip.waypoints, locationId] } }));
      get().markTripStale();
    },
    removeWaypoint: (index) => {
      set((s) => ({ trip: { ...s.trip, waypoints: s.trip.waypoints.filter((_, i) => i !== index) } }));
      get().markTripStale();
    },
    moveWaypoint: (index, delta) => {
      const waypoints = [...get().trip.waypoints];
      const next = index + delta;
      if (next < 0 || next >= waypoints.length) return;
      [waypoints[index], waypoints[next]] = [waypoints[next], waypoints[index]];
      set((s) => ({ trip: { ...s.trip, waypoints } }));
      get().markTripStale();
    },
    setTripMode: (mode) => {
      set((s) => ({ trip: { ...s.trip, mode } }));
      get().markTripStale();
    },
    setTripAxis: (axis, on) => {
      set((s) => ({ trip: { ...s.trip, axes: { ...s.trip.axes, [axis]: on } } }));
      get().markTripStale();
    },
    setAutoPlan: (autoPlan) => {
      set((s) => ({ trip: { ...s.trip, autoPlan } }));
      if (autoPlan && get().trip.stale) void get().startPlan();
    },

    /** Any routing-relevant edit: re-solve, or flag the saved plan as stale. */
    markTripStale: () => {
      const { trip } = get();
      if (trip.plan) set((s) => ({ trip: { ...s.trip, stale: true } }));
      if (trip.waypoints.length < 2 || !trip.autoPlan) return;
      /* coalesce rapid edits so we don't spin up a worker per keystroke */
      cancelTripDebounce();
      tripTimer = setTimeout(() => {
        tripTimer = null;
        void get().startPlan();
      }, TRIP_DEBOUNCE_MS);
    },

    startPlan: async () => {
      cancelTripDebounce();
      const { trip, locations, connections, settings } = get();
      if (trip.waypoints.length < 2) {
        set((s) => ({ trip: { ...s.trip, running: false, progress: null, stale: false } }));
        return;
      }

      plannerRun?.discard();

      const input: PlannerInput = {
        locations: Object.values(locations).map((l) => ({
          id: l.id,
          visited: l.visited,
          coordX: l.coordX,
          coordY: l.coordY,
          coordZ: l.coordZ
        })),
        connections: Object.values(connections).map((c) => ({
          id: c.id,
          sourceId: c.sourceId,
          targetId: c.targetId,
          arrowSource: c.arrowSource,
          arrowTarget: c.arrowTarget,
          weight: c.weight,
          locked: c.locked,
          requires: c.requires
        })),
        waypoints: trip.waypoints,
        options: { mode: trip.mode, axes: trip.axes },
        budget: {
          maxStates: MAX_PLANNER_STATES,
          maxMs: settings.limitSearchTime
            ? Math.max(1, Math.round(settings.searchTimeLimitSeconds)) * 1000
            : null
        }
      };

      set((s) => ({ trip: { ...s.trip, running: true, progress: { states: 0, elapsedMs: 0 } } }));

      const run = runPlanner(input, (states, elapsedMs) => {
        if (plannerRun !== run) return;
        set((s) => ({ trip: { ...s.trip, progress: { states, elapsedMs } } }));
      });
      plannerRun = run;

      try {
        const plan = await run.promise;
        if (!plan || plannerRun !== run) return; // discarded or superseded
        plannerRun = null;
        const slow = plan.elapsedMs > AUTO_PLAN_LIMIT_MS;
        const turnOff = slow && get().trip.autoPlan;
        set((s) => ({
          trip: {
            ...s.trip,
            plan,
            stale: false,
            running: false,
            progress: null,
            autoPlan: turnOff ? false : s.trip.autoPlan
          }
        }));
        if (turnOff) flash('Search Took Over 500ms — Auto-Recompute Turned Off');
      } catch (err) {
        if (plannerRun === run) plannerRun = null;
        set((s) => ({ trip: { ...s.trip, running: false, progress: null } }));
        set({ error: err instanceof Error ? err.message : 'Route planning failed' });
      }
    },

    cancelPlan: () => plannerRun?.cancel(),

    clearTrip: () => {
      cancelTripDebounce();
      plannerRun?.discard();
      plannerRun = null;
      set((s) => ({
        trip: { ...EMPTY_TRIP, mode: s.trip.mode, axes: s.trip.axes, autoPlan: s.trip.autoPlan }
      }));
    },

    resetAllVisited: async () => {
      const { mapId } = get();
      if (!mapId) return;
      await guardScoped(() => api.resetVisited(mapId));
      if (get().error) return;
      set((s) => {
        const locations = { ...s.locations };
        for (const [k, l] of Object.entries(locations)) {
          if (l.visited) locations[k] = { ...l, visited: false };
        }
        return { locations };
      });
      get().markTripStale();
      flash('All Locations Marked Unvisited');
    },

    /* ------------------------------------------------------- locations */
    createLocationAt: async (x, y, groupId) => {
      const { mapId } = get();
      if (!mapId) return;
      const created = await guardScoped(() =>
        api.createLocation(mapId, { name: 'New Location', x, y, groupId: groupId ?? null })
      );
      if (!created) return;
      set((s) => ({
        locations: { ...s.locations, [created.id]: created },
        selection: { type: 'location', id: created.id },
        multiSelect: [],
        mode: 'select',
        contextMenu: null
      }));
      flash('Location Created — Rename It In The Inspector');
      if (groupId) afterStructureChange();
    },

    updateLocation: async (id, patch) => {
      /* a pending draft can flush after its row is gone (Delete, map switch) */
      if (!get().locations[id]) return;
      const updated = await guardScoped(() => api.updateLocation(id, patch));
      if (!updated) return;
      set((s) => ({ locations: { ...s.locations, [id]: updated } }));
      if ('visited' in patch || 'coordX' in patch || 'coordY' in patch || 'coordZ' in patch) {
        get().markTripStale();
      }
    },

    bulkUpdateLocations: async (ids, patch) => {
      if (!ids.length) return;
      const mapAtStart = get().mapId;
      set({ busy: true, error: null });
      const { ok, failed, total, firstError } = await settleBatch(
        ids.map((id) => api.updateLocation(id, patch))
      );
      set({ busy: false });
      if (get().mapId !== mapAtStart) return;

      if (ok.length) {
        set((s) => {
          const locations = { ...s.locations };
          for (const loc of ok) locations[loc.id] = loc;
          return { locations };
        });
      }
      if (failed) {
        const reason = firstError?.reason;
        set({
          error: `${ok.length} of ${total} locations updated — ${failed} failed${
            reason instanceof Error ? `: ${reason.message}` : ''
          }`
        });
      } else flash(`Updated ${total} Locations`);

      if ('groupId' in patch) afterStructureChange();
      if ('visited' in patch) get().markTripStale();
    },

    deleteLocation: async (id) => {
      await get().deleteLocations([id]);
    },

    deleteLocations: async (ids) => {
      if (!ids.length) return;
      const mapAtStart = get().mapId;
      set({ busy: true, error: null });
      const results = await Promise.allSettled(
        ids.map(async (id) => {
          await api.deleteLocation(id);
          return id;
        })
      );
      set({ busy: false });
      if (get().mapId !== mapAtStart) return;

      const removed = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      const failed = results.length - removed.length;
      if (removed.length) {
        const gone = new Set(removed);
        set((s) => {
          const locations = { ...s.locations };
          for (const id of removed) delete locations[id];
          const connections: Record<string, Connection> = {};
          for (const [key, c] of Object.entries(s.connections)) {
            if (gone.has(c.sourceId) || gone.has(c.targetId)) continue;
            connections[key] = c.requires.some((r) => gone.has(r))
              ? { ...c, requires: c.requires.filter((r) => !gone.has(r)) }
              : c;
          }
          return {
            locations,
            connections,
            selection: null,
            multiSelect: [],
            contextMenu: null,
            trip: { ...s.trip, waypoints: s.trip.waypoints.filter((w) => !gone.has(w)) }
          };
        });
        get().markTripStale();
      }
      if (failed) set({ error: `${removed.length} of ${results.length} locations deleted — ${failed} failed` });
      else flash(removed.length > 1 ? `${removed.length} Locations Deleted` : 'Location Deleted');
    },

    toggleVisited: async (id) => {
      const loc = get().locations[id];
      if (!loc) return;
      await get().updateLocation(id, { visited: !loc.visited });
    },

    /* ------------------------------------------------------- groupings */
    createGroupFrom: async (locationIds) => {
      const { mapId } = get();
      if (!mapId || !locationIds.length) return;
      const created = await guardScoped(() =>
        api.createGroup(mapId, { name: 'New Grouping', locationIds })
      );
      if (!created) return;
      set((s) => {
        const locations = { ...s.locations };
        for (const id of locationIds) {
          if (locations[id]) locations[id] = { ...locations[id], groupId: created.id };
        }
        return {
          groups: { ...s.groups, [created.id]: created },
          locations,
          selection: { type: 'group', id: created.id },
          multiSelect: [],
          contextMenu: null
        };
      });
      flash('Grouping Created — Name It In The Inspector');
      afterStructureChange();
    },

    updateGroup: async (id, patch) => {
      if (!get().groups[id]) return;
      const updated = await guardScoped(() => api.updateGroup(id, patch));
      if (!updated) return;
      set((s) => ({ groups: { ...s.groups, [id]: updated } }));
    },

    deleteGroup: async (id) => {
      await guardScoped(() => api.deleteGroup(id));
      if (get().error) return;
      set((s) => {
        const groups = { ...s.groups };
        delete groups[id];
        /* sub-groupings and rooms simply move up a level */
        for (const [key, g] of Object.entries(groups)) {
          if (g.parentId === id) groups[key] = { ...g, parentId: null };
        }
        const locations = { ...s.locations };
        for (const [key, l] of Object.entries(locations)) {
          if (l.groupId === id) locations[key] = { ...l, groupId: null };
        }
        return { groups, locations, selection: null, contextMenu: null };
      });
      flash('Grouping Deleted (Contents Kept)');
      afterStructureChange();
    },

    ungroupAll: async (id) => {
      await guardScoped(() => api.ungroupAll(id));
      if (get().error) return;
      set((s) => {
        const locations = { ...s.locations };
        for (const [key, l] of Object.entries(locations)) {
          if (l.groupId === id) locations[key] = { ...l, groupId: null };
        }
        return { locations, contextMenu: null };
      });
      flash('All Rooms Removed From The Grouping');
      afterStructureChange();
    },

    setLocationGroup: async (locationId, groupId) => {
      const updated = await guardScoped(() => api.updateLocation(locationId, { groupId }));
      if (!updated) return;
      set((s) => ({ locations: { ...s.locations, [locationId]: updated }, contextMenu: null }));
      afterStructureChange();
    },

    setGroupParent: async (groupId, parentId) => {
      if (!get().groups[groupId]) return;
      if (parentId && descendantGroupIds(Object.values(get().groups), groupId).has(parentId)) {
        set({ error: 'A grouping cannot be nested inside itself' });
        return;
      }
      const updated = await guardScoped(() => api.updateGroup(groupId, { parentId }));
      if (!updated) return;
      set((s) => ({ groups: { ...s.groups, [groupId]: updated }, contextMenu: null }));
      afterStructureChange();
    },

    /* ---------------------------------------------------- location labels */
    createLocationLabel: async (name) => {
      const { mapId } = get();
      if (!mapId) return;
      const created = await guardScoped(() => api.createLocationLabel(mapId, { name }));
      if (!created) return;
      set((s) => ({
        locationLabels: { ...s.locationLabels, [created.id]: created },
        selection: { type: 'location-label', id: created.id },
        multiSelect: []
      }));
      flash('Label Created — Set Its Defaults In The Inspector');
    },

    updateLocationLabel: async (id, patch) => {
      if (!get().locationLabels[id]) return;
      const updated = await guardScoped(() => api.updateLocationLabel(id, patch));
      if (!updated) return;
      set((s) => ({ locationLabels: { ...s.locationLabels, [id]: updated } }));
    },

    deleteLocationLabel: async (id) => {
      await guardScoped(() => api.deleteLocationLabel(id));
      if (get().error) return;
      set((s) => {
        const locationLabels = { ...s.locationLabels };
        delete locationLabels[id];
        const locations = { ...s.locations };
        for (const [key, l] of Object.entries(locations)) {
          if (l.labelIds.includes(id)) {
            locations[key] = { ...l, labelIds: l.labelIds.filter((x) => x !== id) };
          }
        }
        return { locationLabels, locations, selection: null };
      });
      flash('Label Deleted (Styling Kept)');
    },

    applyLocationLabelToAll: async (id) => {
      const result = await guardScoped(() => api.applyLocationLabelToAll(id));
      if (!result) return;
      set((s) => {
        const locations = { ...s.locations };
        for (const l of result.locations) locations[l.id] = l;
        return { locations };
      });
      flash(`Styling Applied To ${result.locations.length} Rooms`);
      afterStructureChange();
    },

    assignLocationLabel: async (locationId, labelId) => {
      const before = get().locations[locationId];
      const updated = await guardScoped(() => api.assignLocationLabel(locationId, labelId));
      if (!updated) return;
      set((s) => ({ locations: { ...s.locations, [locationId]: updated } }));
      if (before && before.groupId !== updated.groupId) afterStructureChange();
    },

    unassignLocationLabel: async (locationId, labelId) => {
      const updated = await guardScoped(() => api.unassignLocationLabel(locationId, labelId));
      if (!updated) return;
      set((s) => ({ locations: { ...s.locations, [locationId]: updated } }));
    },

    applyLocationLabelStyling: async (locationId, labelId) => {
      const before = get().locations[locationId];
      const updated = await guardScoped(() => api.applyLocationLabelStyling(locationId, labelId));
      if (!updated) return;
      set((s) => ({ locations: { ...s.locations, [locationId]: updated } }));
      flash('Label Styling Applied');
      if (before && before.groupId !== updated.groupId) afterStructureChange();
    },

    bulkAssignLocationLabel: async (locationIds, labelId) => {
      if (!locationIds.length) return;
      const mapAtStart = get().mapId;
      set({ busy: true, error: null });
      const { ok, failed, total } = await settleBatch(
        locationIds.map((id) => api.assignLocationLabel(id, labelId))
      );
      set({ busy: false });
      if (get().mapId !== mapAtStart) return;
      if (ok.length) {
        set((s) => {
          const locations = { ...s.locations };
          for (const loc of ok) locations[loc.id] = loc;
          return { locations };
        });
      }
      if (failed) set({ error: `Label applied to ${ok.length} of ${total} rooms — ${failed} failed` });
      else flash(`Label Applied To ${total} Rooms`);
      afterStructureChange();
    },

    /* -------------------------------------------------- connection labels */
    createConnectionLabel: async (name) => {
      const { mapId } = get();
      if (!mapId) return;
      const created = await guardScoped(() => api.createConnectionLabel(mapId, { name }));
      if (!created) return;
      set((s) => ({
        connectionLabels: { ...s.connectionLabels, [created.id]: created },
        selection: { type: 'connection-label', id: created.id },
        multiSelect: []
      }));
      flash('Label Created — Set Its Defaults In The Inspector');
    },

    updateConnectionLabel: async (id, patch) => {
      if (!get().connectionLabels[id]) return;
      const updated = await guardScoped(() => api.updateConnectionLabel(id, patch));
      if (!updated) return;
      set((s) => ({ connectionLabels: { ...s.connectionLabels, [id]: updated } }));
    },

    deleteConnectionLabel: async (id) => {
      await guardScoped(() => api.deleteConnectionLabel(id));
      if (get().error) return;
      set((s) => {
        const connectionLabels = { ...s.connectionLabels };
        delete connectionLabels[id];
        const connections = { ...s.connections };
        for (const [key, c] of Object.entries(connections)) {
          if (c.labelIds.includes(id)) {
            connections[key] = { ...c, labelIds: c.labelIds.filter((x) => x !== id) };
          }
        }
        return { connectionLabels, connections, selection: null };
      });
      flash('Label Deleted (Styling Kept)');
    },

    applyConnectionLabelToAll: async (id) => {
      const result = await guardScoped(() => api.applyConnectionLabelToAll(id));
      if (!result) return;
      set((s) => {
        const connections = { ...s.connections };
        for (const c of result.connections) connections[c.id] = c;
        return { connections };
      });
      flash(`Styling Applied To ${result.connections.length} Connections`);
      get().markTripStale();
    },

    assignConnectionLabel: async (connectionId, labelId) => {
      const updated = await guardScoped(() => api.assignConnectionLabel(connectionId, labelId));
      if (!updated) return;
      set((s) => ({ connections: { ...s.connections, [connectionId]: updated } }));
      get().markTripStale();
    },

    unassignConnectionLabel: async (connectionId, labelId) => {
      const updated = await guardScoped(() => api.unassignConnectionLabel(connectionId, labelId));
      if (!updated) return;
      set((s) => ({ connections: { ...s.connections, [connectionId]: updated } }));
    },

    applyConnectionLabelStyling: async (connectionId, labelId) => {
      const updated = await guardScoped(() => api.applyConnectionLabelStyling(connectionId, labelId));
      if (!updated) return;
      set((s) => ({ connections: { ...s.connections, [connectionId]: updated } }));
      flash('Label Styling Applied');
      get().markTripStale();
    },

    /* ----------------------------------------------------- connections */
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
      const created = await guardScoped(() =>
        api.createConnection(mapId, { sourceId, targetId, ...rest, ...arrowsFor(direction) })
      );
      if (!created) return;
      set((s) => ({
        connections: { ...s.connections, [created.id]: created },
        selection: { type: 'connection', id: created.id },
        multiSelect: []
      }));
      flash('Connection Created');
      get().markTripStale();
    },

    updateConnection: async (id, patch) => {
      if (!get().connections[id]) return;
      const updated = await guardScoped(() => api.updateConnection(id, patch));
      if (!updated) return;
      set((s) => ({ connections: { ...s.connections, [id]: updated } }));
      get().markTripStale();
    },

    deleteConnection: async (id) => {
      await guardScoped(() => api.deleteConnection(id));
      if (get().error) return;
      set((s) => {
        const connections = { ...s.connections };
        delete connections[id];
        return { connections, selection: null, contextMenu: null };
      });
      get().markTripStale();
      flash('Connection Deleted');
    },

    deleteSelection: async () => {
      const { selection, multiSelect } = get();
      if (multiSelect.length > 1) {
        await get().deleteLocations(multiSelect);
        return;
      }
      if (!selection) return;
      if (selection.type === 'location') await get().deleteLocation(selection.id);
      else if (selection.type === 'connection') await get().deleteConnection(selection.id);
      else await get().deleteGroup(selection.id);
    },

    /* --------------------------------------------------- layout saving */
    queuePosition: (id, x, y) => {
      set((s) => ({ pendingPositions: { ...s.pendingPositions, [id]: { x, y } } }));
      if (positionTimer) clearTimeout(positionTimer);
      positionTimer = setTimeout(() => void get().flushPositions(), 600);
    },

    /* a multi-drag calling `queuePosition` once per node does an object spread
       per node — O(N²) for N moved nodes. Batch them into one spread instead. */
    queuePositions: (list) => {
      if (!list.length) return;
      set((s) => {
        const pendingPositions = { ...s.pendingPositions };
        for (const p of list) pendingPositions[p.id] = { x: p.x, y: p.y };
        return { pendingPositions };
      });
      if (positionTimer) clearTimeout(positionTimer);
      positionTimer = setTimeout(() => void get().flushPositions(), 600);
    },

    queuePortalOffset: (portalId, dx, dy) => {
      set((s) => ({ pendingPortalOffsets: { ...s.pendingPortalOffsets, [portalId]: { dx, dy } } }));
      if (positionTimer) clearTimeout(positionTimer);
      positionTimer = setTimeout(() => void get().flushPositions(), 600);
    },

    flushPositions: async () => {
      cancelPositionFlush();
      const { pendingPositions, pendingPortalOffsets, mapId, locations, connections } = get();
      const positions = Object.entries(pendingPositions)
        .filter(([id]) => locations[id])
        .map(([id, p]) => ({ id, x: p.x, y: p.y }));
      const portalOffsets: PortalOffset[] = [];
      for (const [id, o] of Object.entries(pendingPortalOffsets)) {
        const parsed = parsePortalId(id);
        if (!parsed || !connections[parsed.connectionId]) continue;
        portalOffsets.push({ connectionId: parsed.connectionId, side: parsed.side, dx: o.dx, dy: o.dy });
      }
      if (!mapId || (!positions.length && !portalOffsets.length)) {
        set({ pendingPositions: {}, pendingPortalOffsets: {} });
        return;
      }
      try {
        await api.savePositions(mapId, positions, portalOffsets);
        set({
          locations: mergePositions(get().locations, positions),
          connections: mergePortalOffsets(get().connections, portalOffsets),
          pendingPositions: {},
          pendingPortalOffsets: {}
        });
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      }
    },

    persistLayoutPositions: async (positions, portalOffsets) => {
      const { mapId } = get();
      if (!mapId || (!positions.length && !portalOffsets.length)) return;
      try {
        await api.savePositions(mapId, positions, portalOffsets);
        set({
          locations: mergePositions(get().locations, positions),
          connections: mergePortalOffsets(get().connections, portalOffsets),
          layout: 'preset',
          pendingPositions: {},
          pendingPortalOffsets: {}
        });
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  };
});
