import type {
  Connection,
  GraphMap,
  GraphPayload,
  Location,
  MapSummary
} from './types';

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const json = (body: unknown) => ({ body: JSON.stringify(body) });

export const api = {
  /* maps */
  listMaps: () => request<MapSummary[]>('/maps'),
  createMap: (name: string, description = '') =>
    request<MapSummary>('/maps', { method: 'POST', ...json({ name, description }) }),
  updateMap: (id: string, patch: Partial<Pick<GraphMap, 'name' | 'description'>>) =>
    request<GraphMap>(`/maps/${id}`, { method: 'PATCH', ...json(patch) }),
  deleteMap: (id: string) => request<void>(`/maps/${id}`, { method: 'DELETE' }),
  getGraph: (id: string) => request<GraphPayload>(`/maps/${id}`),
  exportMap: (id: string) => request<unknown>(`/maps/${id}/export`),
  importMap: (payload: unknown) =>
    request<GraphPayload>('/maps/import', { method: 'POST', ...json(payload) }),
  savePositions: (
    mapId: string,
    positions: Array<{ id: string; x: number; y: number }>
  ) =>
    request<void>(`/maps/${mapId}/positions`, {
      method: 'PUT',
      ...json({ positions })
    }),

  /* locations */
  createLocation: (mapId: string, body: Partial<Location>) =>
    request<Location>(`/maps/${mapId}/locations`, { method: 'POST', ...json(body) }),
  updateLocation: (id: string, patch: Partial<Location>) =>
    request<Location>(`/locations/${id}`, { method: 'PATCH', ...json(patch) }),
  deleteLocation: (id: string) =>
    request<void>(`/locations/${id}`, { method: 'DELETE' }),

  /* connections */
  createConnection: (mapId: string, body: Partial<Connection>) =>
    request<Connection>(`/maps/${mapId}/connections`, { method: 'POST', ...json(body) }),
  updateConnection: (id: string, patch: Partial<Connection>) =>
    request<Connection>(`/connections/${id}`, { method: 'PATCH', ...json(patch) }),
  deleteConnection: (id: string) =>
    request<void>(`/connections/${id}`, { method: 'DELETE' })
};
