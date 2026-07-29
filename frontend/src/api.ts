import type {
  Connection,
  ConnectionLabel,
  GraphMap,
  GraphPayload,
  Group,
  Location,
  LocationLabel,
  MapSummary,
  PortalOffset
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
    request<GraphPayload & { warnings?: string[] }>('/maps/import', {
      method: 'POST',
      ...json(payload)
    }),
  savePositions: (
    mapId: string,
    positions: Array<{ id: string; x: number; y: number }>,
    portalOffsets: PortalOffset[] = []
  ) =>
    request<void>(`/maps/${mapId}/positions`, {
      method: 'PUT',
      ...json({ positions, portalOffsets })
    }),
  resetVisited: (mapId: string) =>
    request<{ cleared: number }>(`/maps/${mapId}/reset-visited`, { method: 'POST', ...json({}) }),

  /* groups */
  createGroup: (
    mapId: string,
    body: {
      name?: string;
      color?: string;
      notes?: string;
      parentId?: string | null;
      locationIds?: string[];
    }
  ) => request<Group>(`/maps/${mapId}/groups`, { method: 'POST', ...json(body) }),
  updateGroup: (
    id: string,
    patch: Partial<Pick<Group, 'name' | 'color' | 'textColor' | 'notes' | 'parentId'>>
  ) => request<Group>(`/groups/${id}`, { method: 'PATCH', ...json(patch) }),
  deleteGroup: (id: string) => request<void>(`/groups/${id}`, { method: 'DELETE' }),
  ungroupAll: (id: string) =>
    request<{ released: number }>(`/groups/${id}/ungroup`, { method: 'POST', ...json({}) }),

  /* locations */
  createLocation: (mapId: string, body: Partial<Location>) =>
    request<Location>(`/maps/${mapId}/locations`, { method: 'POST', ...json(body) }),
  updateLocation: (id: string, patch: Partial<Location>) =>
    request<Location>(`/locations/${id}`, { method: 'PATCH', ...json(patch) }),
  deleteLocation: (id: string) => request<void>(`/locations/${id}`, { method: 'DELETE' }),

  /* connections */
  createConnection: (mapId: string, body: Partial<Connection>) =>
    request<Connection>(`/maps/${mapId}/connections`, { method: 'POST', ...json(body) }),
  updateConnection: (id: string, patch: Partial<Connection>) =>
    request<Connection>(`/connections/${id}`, { method: 'PATCH', ...json(patch) }),
  deleteConnection: (id: string) => request<void>(`/connections/${id}`, { method: 'DELETE' }),

  /* location labels */
  createLocationLabel: (mapId: string, body: Partial<LocationLabel>) =>
    request<LocationLabel>(`/maps/${mapId}/location-labels`, { method: 'POST', ...json(body) }),
  updateLocationLabel: (id: string, patch: Partial<LocationLabel>) =>
    request<LocationLabel>(`/location-labels/${id}`, { method: 'PATCH', ...json(patch) }),
  deleteLocationLabel: (id: string) =>
    request<void>(`/location-labels/${id}`, { method: 'DELETE' }),
  applyLocationLabelToAll: (id: string) =>
    request<{ locations: Location[] }>(`/location-labels/${id}/apply`, {
      method: 'POST',
      ...json({})
    }),
  assignLocationLabel: (locationId: string, labelId: string) =>
    request<Location>(`/locations/${locationId}/labels`, {
      method: 'POST',
      ...json({ labelId, applyStyling: true })
    }),
  unassignLocationLabel: (locationId: string, labelId: string) =>
    request<Location>(`/locations/${locationId}/labels/${labelId}`, { method: 'DELETE' }),
  applyLocationLabelStyling: (locationId: string, labelId: string) =>
    request<Location>(`/locations/${locationId}/labels/${labelId}/apply`, {
      method: 'POST',
      ...json({})
    }),

  /* connection labels */
  createConnectionLabel: (mapId: string, body: Partial<ConnectionLabel>) =>
    request<ConnectionLabel>(`/maps/${mapId}/connection-labels`, { method: 'POST', ...json(body) }),
  updateConnectionLabel: (id: string, patch: Partial<ConnectionLabel>) =>
    request<ConnectionLabel>(`/connection-labels/${id}`, { method: 'PATCH', ...json(patch) }),
  deleteConnectionLabel: (id: string) =>
    request<void>(`/connection-labels/${id}`, { method: 'DELETE' }),
  applyConnectionLabelToAll: (id: string) =>
    request<{ connections: Connection[] }>(`/connection-labels/${id}/apply`, {
      method: 'POST',
      ...json({})
    }),
  assignConnectionLabel: (connectionId: string, labelId: string) =>
    request<Connection>(`/connections/${connectionId}/labels`, {
      method: 'POST',
      ...json({ labelId, applyStyling: true })
    }),
  unassignConnectionLabel: (connectionId: string, labelId: string) =>
    request<Connection>(`/connections/${connectionId}/labels/${labelId}`, { method: 'DELETE' }),
  applyConnectionLabelStyling: (connectionId: string, labelId: string) =>
    request<Connection>(`/connections/${connectionId}/labels/${labelId}/apply`, {
      method: 'POST',
      ...json({})
    })
};
