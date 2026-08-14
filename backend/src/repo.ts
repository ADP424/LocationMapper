import type { PoolClient } from 'pg';
import { pool } from './db';
import { badRequest, notFound } from './http';
import { mapConnection, mapConnectionLabel, mapLocation, mapLocationLabel } from './mappers';
import type { Connection, ConnectionLabel, Location, LocationLabel } from './types';

const runner = (client?: PoolClient) => client ?? pool;

/* ------------------------------------------------------------- ownership */

/** Only these tables may be asked for their owning map; no SQL is interpolated. */
const MAP_OWNER_SQL = {
  groups: 'SELECT map_id FROM groups WHERE id = $1',
  locations: 'SELECT map_id FROM locations WHERE id = $1',
  connections: 'SELECT map_id FROM connections WHERE id = $1',
  location_labels: 'SELECT map_id FROM location_labels WHERE id = $1',
  connection_labels: 'SELECT map_id FROM connection_labels WHERE id = $1'
} as const;

export type MapOwnedTable = keyof typeof MAP_OWNER_SQL;

const OWNER_LABEL: Record<MapOwnedTable, string> = {
  groups: 'group',
  locations: 'location',
  connections: 'connection',
  location_labels: 'location label',
  connection_labels: 'connection label'
};

export async function mapIdOf(table: MapOwnedTable, id: string): Promise<string> {
  const { rows } = await pool.query(MAP_OWNER_SQL[table], [id]);
  if (!rows.length) throw notFound(OWNER_LABEL[table]);
  return rows[0].map_id as string;
}

export async function assertMapExists(mapId: string) {
  const { rowCount } = await pool.query('SELECT 1 FROM maps WHERE id = $1', [mapId]);
  if (!rowCount) throw notFound('map');
}

export async function assertGroupOnMap(groupId: string, mapId: string) {
  if ((await mapIdOf('groups', groupId)) !== mapId) {
    throw badRequest('the grouping belongs to a different map');
  }
}

/** Every id must belong to `mapId`, or it's a 400. */
export async function assertLocationsOnMap(mapId: string, ids: string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM locations WHERE map_id = $1 AND id = ANY($2::uuid[])`,
    [mapId, unique]
  );
  if (rows[0].n !== unique.length) {
    throw badRequest('all referenced locations must belong to the same map');
  }
}

/* ---------------------------------------------------------- requirements */

const REQUIREMENT_TABLES = {
  connection: { table: 'connection_requirements', fk: 'connection_id' },
  label: { table: 'connection_label_requirements', fk: 'label_id' }
} as const;

/** Replace an unlock condition set in one statement. */
export async function replaceRequirements(
  client: PoolClient,
  owner: keyof typeof REQUIREMENT_TABLES,
  ownerId: string,
  locationIds: string[]
) {
  const { table, fk } = REQUIREMENT_TABLES[owner];
  await client.query(`DELETE FROM ${table} WHERE ${fk} = $1`, [ownerId]);
  const unique = [...new Set(locationIds)];
  if (!unique.length) return;
  await client.query(
    `INSERT INTO ${table} (${fk}, location_id)
     SELECT $1, id FROM unnest($2::uuid[]) AS t(id)
     ON CONFLICT DO NOTHING`,
    [ownerId, unique]
  );
}

/**
 * Replace a label's restart targets in one statement. A restart is *structure*,
 * not styling: nothing in styling.ts ever touches it, and nothing stamps it onto
 * a room — it is a property of the label itself.
 */
export async function replaceRestartTargets(
  client: PoolClient,
  labelId: string,
  locationIds: string[]
) {
  await client.query(`DELETE FROM location_label_restarts WHERE label_id = $1`, [labelId]);
  const unique = [...new Set(locationIds)];
  if (!unique.length) return;
  await client.query(
    `INSERT INTO location_label_restarts (label_id, location_id)
     SELECT $1, id FROM unnest($2::uuid[]) AS t(id)
     ON CONFLICT DO NOTHING`,
    [labelId, unique]
  );
}

/* -------------------------------------------------------------- fetching */

const LOCATION_SQL = `
  SELECT l.*,
         COALESCE((SELECT array_agg(a.label_id ORDER BY a.applied_at, a.label_id)
                     FROM location_label_assignments a
                    WHERE a.location_id = l.id), '{}') AS label_ids,
         /* oldest first: [0] is the layout anchor. \`seq\` — not just \`added_at\` —
            breaks ties between rows inserted in the same statement/transaction,
            which share one timestamp (a bulk import, a multi-membership create) */
         COALESCE((SELECT array_agg(a.group_id ORDER BY a.added_at, a.seq)
                     FROM location_group_assignments a
                    WHERE a.location_id = l.id), '{}') AS group_ids
    FROM locations l
`;

const CONNECTION_SQL = `
  SELECT c.*,
         COALESCE((SELECT array_agg(r.location_id)
                     FROM connection_requirements r
                    WHERE r.connection_id = c.id), '{}') AS requires,
         COALESCE((SELECT array_agg(a.label_id ORDER BY a.applied_at, a.label_id)
                     FROM connection_label_assignments a
                    WHERE a.connection_id = c.id), '{}') AS label_ids
    FROM connections c
`;

const CONNECTION_LABEL_SQL = `
  SELECT cl.*,
         COALESCE((SELECT array_agg(r.location_id)
                     FROM connection_label_requirements r
                    WHERE r.label_id = cl.id), '{}') AS default_requires
    FROM connection_labels cl
`;

const LOCATION_LABEL_SQL = `
  SELECT ll.*,
         /* ordered, so a PATCH that only reorders is never reported as a change */
         COALESCE((SELECT array_agg(r.location_id ORDER BY r.location_id)
                     FROM location_label_restarts r
                    WHERE r.label_id = ll.id), '{}') AS restart_targets
    FROM location_labels ll
`;

export async function fetchLocation(id: string, client?: PoolClient): Promise<Location> {
  const { rows } = await runner(client).query(`${LOCATION_SQL} WHERE l.id = $1`, [id]);
  if (!rows.length) throw notFound('location');
  return mapLocation(rows[0]);
}

export async function fetchLocations(mapId: string): Promise<Location[]> {
  const { rows } = await pool.query(`${LOCATION_SQL} WHERE l.map_id = $1 ORDER BY l.created_at`, [
    mapId
  ]);
  return rows.map(mapLocation);
}

export async function fetchLocationsByLabel(labelId: string): Promise<Location[]> {
  const { rows } = await pool.query(
    `${LOCATION_SQL}
      WHERE l.id IN (SELECT location_id FROM location_label_assignments WHERE label_id = $1)
      ORDER BY l.created_at`,
    [labelId]
  );
  return rows.map(mapLocation);
}

export async function fetchLocationsByGroup(groupId: string): Promise<Location[]> {
  const { rows } = await pool.query(
    `${LOCATION_SQL}
      WHERE l.id IN (SELECT location_id FROM location_group_assignments WHERE group_id = $1)
      ORDER BY l.created_at`,
    [groupId]
  );
  return rows.map(mapLocation);
}

export async function fetchConnection(id: string, client?: PoolClient): Promise<Connection> {
  const { rows } = await runner(client).query(`${CONNECTION_SQL} WHERE c.id = $1`, [id]);
  if (!rows.length) throw notFound('connection');
  return mapConnection(rows[0]);
}

export async function fetchConnections(mapId: string): Promise<Connection[]> {
  const { rows } = await pool.query(`${CONNECTION_SQL} WHERE c.map_id = $1 ORDER BY c.created_at`, [
    mapId
  ]);
  return rows.map(mapConnection);
}

export async function fetchConnectionsByLabel(labelId: string): Promise<Connection[]> {
  const { rows } = await pool.query(
    `${CONNECTION_SQL}
      WHERE c.id IN (SELECT connection_id FROM connection_label_assignments WHERE label_id = $1)
      ORDER BY c.created_at`,
    [labelId]
  );
  return rows.map(mapConnection);
}

export async function fetchLocationLabels(mapId: string): Promise<LocationLabel[]> {
  const { rows } = await pool.query(
    `${LOCATION_LABEL_SQL} WHERE ll.map_id = $1 ORDER BY ll.name, ll.created_at`,
    [mapId]
  );
  return rows.map(mapLocationLabel);
}

export async function fetchLocationLabel(id: string): Promise<LocationLabel> {
  const { rows } = await pool.query(`${LOCATION_LABEL_SQL} WHERE ll.id = $1`, [id]);
  if (!rows.length) throw notFound('location label');
  return mapLocationLabel(rows[0]);
}

export async function fetchConnectionLabels(mapId: string): Promise<ConnectionLabel[]> {
  const { rows } = await pool.query(
    `${CONNECTION_LABEL_SQL} WHERE cl.map_id = $1 ORDER BY cl.name, cl.created_at`,
    [mapId]
  );
  return rows.map(mapConnectionLabel);
}

export async function fetchConnectionLabel(id: string): Promise<ConnectionLabel> {
  const { rows } = await pool.query(`${CONNECTION_LABEL_SQL} WHERE cl.id = $1`, [id]);
  if (!rows.length) throw notFound('connection label');
  return mapConnectionLabel(rows[0]);
}
