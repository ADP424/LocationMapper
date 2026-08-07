/**
 * Which world folder a map is looking at, remembered per map.
 *
 * Deliberately local rather than a column on `maps`: the path is a property of
 * *this machine*, not of the map. Two people opening the same map keep their
 * own save on their own disk, and nothing about the graph changes if the folder
 * moves. If world sharing ever arrives it will be a server-side world id — a
 * different thing from this, which is why it is not in the database now.
 */

const KEY = 'mapgraph.world.v1';

export interface WorldPref {
  /** Absolute path to the world folder — the one containing level.dat. */
  root: string;
  /** Namespaced dimension id, e.g. `minecraft:overworld`. */
  dimensionId: string;
  /** Render distance in chunks. */
  renderDistance: number;
}

export const DEFAULT_WORLD_PREF: WorldPref = {
  root: '',
  dimensionId: 'minecraft:overworld',
  renderDistance: 12
};

type Stored = Record<string, Partial<WorldPref>>;

function readAll(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Stored) : {};
  } catch {
    return {};
  }
}

export function loadWorldPref(mapId: string): WorldPref {
  const stored = readAll()[mapId];
  return {
    root: typeof stored?.root === 'string' ? stored.root : DEFAULT_WORLD_PREF.root,
    dimensionId:
      typeof stored?.dimensionId === 'string' ? stored.dimensionId : DEFAULT_WORLD_PREF.dimensionId,
    renderDistance: Number.isFinite(stored?.renderDistance)
      ? Math.min(24, Math.max(2, Math.round(stored!.renderDistance!)))
      : DEFAULT_WORLD_PREF.renderDistance
  };
}

export function saveWorldPref(mapId: string, patch: Partial<WorldPref>) {
  try {
    const all = readAll();
    all[mapId] = { ...loadWorldPref(mapId), ...patch };
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* private mode / quota — the path simply will not be remembered */
  }
}
