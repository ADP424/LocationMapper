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
const post = (body: unknown = {}) => ({ method: 'POST', ...json(body) });
const patch = (body: unknown) => ({ method: 'PATCH', ...json(body) });
const del = { method: 'DELETE' };

export const api = {
  /* maps */
  listMaps: () => request<MapSummary[]>('/maps'),
  createMap: (name: string, description = '') => request<MapSummary>('/maps', post({ name, description })),
  deleteMap: (id: string) => request<void>(`/maps/${id}`, del),
  updateMap: (
    id: string,
    body: Partial<Pick<GraphMap, 'name' | 'description' | 'startLocationId'>>
  ) => request<GraphMap>(`/maps/${id}`, patch(body)),
  getGraph: (id: string) => request<GraphPayload>(`/maps/${id}`),
  exportMap: (id: string) => request<unknown>(`/maps/${id}/export`),
  importMap: (payload: unknown) =>
    request<GraphPayload & { warnings?: string[] }>('/maps/import', post(payload)),
  savePositions: (
    mapId: string,
    positions: Array<{ id: string; x: number; y: number }>,
    portalOffsets: PortalOffset[] = []
  ) => request<void>(`/maps/${mapId}/positions`, { method: 'PUT', ...json({ positions, portalOffsets }) }),
  resetVisited: (mapId: string) => request<{ cleared: number }>(`/maps/${mapId}/reset-visited`, post()),

  /* groups */
  createGroup: (mapId: string, body: Partial<Group> & { locationIds?: string[] }) =>
    request<Group>(`/maps/${mapId}/groups`, post(body)),
  updateGroup: (id: string, body: Partial<Group>) => request<Group>(`/groups/${id}`, patch(body)),
  deleteGroup: (id: string) => request<void>(`/groups/${id}`, del),
  ungroupAll: (id: string) => request<{ released: number }>(`/groups/${id}/ungroup`, post()),
  applyGroupStylingToAll: (id: string) =>
    request<{ locations: Location[] }>(`/groups/${id}/apply`, post()),
  applyGroupStyling: (locationId: string, groupId: string) =>
    request<Location>(`/locations/${locationId}/groups/${groupId}/apply`, post()),
  assignLocationGroup: (locationId: string, groupId: string) =>
    request<Location>(`/locations/${locationId}/groups`, post({ groupId, applyStyling: true })),
  unassignLocationGroup: (locationId: string, groupId: string) =>
    request<Location>(`/locations/${locationId}/groups/${groupId}`, del),

  /* locations */
  createLocation: (mapId: string, body: Partial<Location>) =>
    request<Location>(`/maps/${mapId}/locations`, post(body)),
  updateLocation: (id: string, body: Partial<Location>) => request<Location>(`/locations/${id}`, patch(body)),
  deleteLocation: (id: string) => request<void>(`/locations/${id}`, del),

  /* connections */
  createConnection: (mapId: string, body: Partial<Connection>) =>
    request<Connection>(`/maps/${mapId}/connections`, post(body)),
  updateConnection: (id: string, body: Partial<Connection>) =>
    request<Connection>(`/connections/${id}`, patch(body)),
  deleteConnection: (id: string) => request<void>(`/connections/${id}`, del),

  /* location labels */
  createLocationLabel: (mapId: string, body: Partial<LocationLabel>) =>
    request<LocationLabel>(`/maps/${mapId}/location-labels`, post(body)),
  updateLocationLabel: (id: string, body: Partial<LocationLabel>) =>
    request<LocationLabel>(`/location-labels/${id}`, patch(body)),
  deleteLocationLabel: (id: string) => request<void>(`/location-labels/${id}`, del),
  applyLocationLabelToAll: (id: string) =>
    request<{ locations: Location[] }>(`/location-labels/${id}/apply`, post()),
  assignLocationLabel: (locationId: string, labelId: string) =>
    request<Location>(`/locations/${locationId}/labels`, post({ labelId, applyStyling: true })),
  unassignLocationLabel: (locationId: string, labelId: string) =>
    request<Location>(`/locations/${locationId}/labels/${labelId}`, del),
  applyLocationLabelStyling: (locationId: string, labelId: string) =>
    request<Location>(`/locations/${locationId}/labels/${labelId}/apply`, post()),

  /* connection labels */
  createConnectionLabel: (mapId: string, body: Partial<ConnectionLabel>) =>
    request<ConnectionLabel>(`/maps/${mapId}/connection-labels`, post(body)),
  updateConnectionLabel: (id: string, body: Partial<ConnectionLabel>) =>
    request<ConnectionLabel>(`/connection-labels/${id}`, patch(body)),
  deleteConnectionLabel: (id: string) => request<void>(`/connection-labels/${id}`, del),
  applyConnectionLabelToAll: (id: string) =>
    request<{ connections: Connection[] }>(`/connection-labels/${id}/apply`, post()),
  assignConnectionLabel: (connectionId: string, labelId: string) =>
    request<Connection>(`/connections/${connectionId}/labels`, post({ labelId, applyStyling: true })),
  unassignConnectionLabel: (connectionId: string, labelId: string) =>
    request<Connection>(`/connections/${connectionId}/labels/${labelId}`, del),
  applyConnectionLabelStyling: (connectionId: string, labelId: string) =>
    request<Connection>(`/connections/${connectionId}/labels/${labelId}/apply`, post())
};
