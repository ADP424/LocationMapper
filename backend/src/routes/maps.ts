import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { query, withTransaction } from '../db';
import { ah, badRequest, notFound } from '../http';
import { mapGroup, mapMap, mapMapSummary } from '../mappers';
import {
  assertLocationsOnMap,
  fetchConnectionLabels,
  fetchConnections,
  fetchLocationLabels,
  fetchLocations,
  replaceRequirements,
  replaceRestartTargets
} from '../repo';
import { insertRows, insertSql, updateSql } from '../sql';
import type { GraphPayload } from '../types';
import { graphImport, mapCreate, mapUpdate, positionsUpdate, uuid } from '../validation';

export const mapsRouter = Router();

async function loadGraph(mapId: string): Promise<GraphPayload> {
  const mapRes = await query(`SELECT * FROM maps WHERE id = $1`, [mapId]);
  if (!mapRes.rows.length) throw notFound('map');
  const groupRes = await query(`SELECT * FROM groups WHERE map_id = $1 ORDER BY created_at`, [mapId]);

  return {
    map: mapMap(mapRes.rows[0]),
    groups: groupRes.rows.map(mapGroup),
    locationLabels: await fetchLocationLabels(mapId),
    connectionLabels: await fetchConnectionLabels(mapId),
    locations: await fetchLocations(mapId),
    connections: await fetchConnections(mapId)
  };
}

mapsRouter.get(
  '/',
  ah(async (_req, res) => {
    const { rows } = await query(
      `SELECT m.*,
              (SELECT count(*) FROM locations   l WHERE l.map_id = m.id)::int AS location_count,
              (SELECT count(*) FROM connections c WHERE c.map_id = m.id)::int AS connection_count
         FROM maps m
        ORDER BY m.updated_at DESC`
    );
    res.json(rows.map(mapMapSummary));
  })
);

mapsRouter.post(
  '/',
  ah(async (req, res) => {
    const body = mapCreate.parse(req.body);
    const { rows } = await query(
      `INSERT INTO maps (name, description) VALUES ($1, $2) RETURNING *`,
      [body.name, body.description ?? '']
    );
    res.status(201).json(mapMapSummary({ ...rows[0], location_count: 0, connection_count: 0 }));
  })
);

mapsRouter.get(
  '/:mapId',
  ah(async (req, res) => {
    res.json(await loadGraph(uuid.parse(req.params.mapId)));
  })
);

mapsRouter.get(
  '/:mapId/export',
  ah(async (req, res) => {
    const graph = await loadGraph(uuid.parse(req.params.mapId));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${graph.map.name.replace(/[^\w.-]+/g, '_')}.json"`
    );
    res.json({
      name: graph.map.name,
      description: graph.map.description,
      startLocationKey: graph.map.startLocationId,
      groups: graph.groups.map((g) => ({
        key: g.id,
        parentKey: g.parentId,
        name: g.name,
        color: g.color,
        textColor: g.textColor,
        notes: g.notes,
        displayStyle: g.displayStyle,
        bodyPadding: g.bodyPadding,
        defaultKind: g.defaultKind,
        defaultSize: g.defaultSize,
        defaultColor: g.defaultColor,
        defaultTextColor: g.defaultTextColor,
        overrideLabels: g.overrideLabels
      })),
      locationLabels: graph.locationLabels.map((l) => ({
        key: l.id,
        name: l.name,
        color: l.color,
        notes: l.notes,
        defaultKind: l.defaultKind,
        defaultSize: l.defaultSize,
        defaultColor: l.defaultColor,
        defaultTextColor: l.defaultTextColor,
        overrideGroupings: l.overrideGroupings,
        restartName: l.restartName,
        restartWeight: l.restartWeight,
        restartTargetKeys: l.restartTargets
      })),
      connectionLabels: graph.connectionLabels.map((l) => ({
        key: l.id,
        name: l.name,
        color: l.color,
        notes: l.notes,
        defaultColor: l.defaultColor,
        defaultTextColor: l.defaultTextColor,
        defaultTravelKind: l.defaultTravelKind,
        defaultDirection: l.defaultDirection,
        defaultWeight: l.defaultWeight,
        defaultEphemeral: l.defaultEphemeral,
        defaultLocked: l.defaultLocked,
        defaultLockNote: l.defaultLockNote,
        defaultRequiresKeys: l.defaultRequires
      })),
      locations: graph.locations.map((l) => ({
        key: l.id,
        groupKeys: l.groupIds,
        name: l.name,
        kind: l.kind,
        size: l.size,
        notes: l.notes,
        color: l.color,
        textColor: l.textColor,
        visited: l.visited,
        x: l.x,
        y: l.y,
        coordX: l.coordX,
        coordY: l.coordY,
        coordZ: l.coordZ,
        labelKeys: l.labelIds
      })),
      connections: graph.connections.map((c) => ({
        sourceKey: c.sourceId,
        targetKey: c.targetId,
        name: c.name,
        notes: c.notes,
        travelKind: c.travelKind,
        color: c.color,
        textColor: c.textColor,
        arrowSource: c.arrowSource,
        arrowTarget: c.arrowTarget,
        ephemeral: c.ephemeral,
        locked: c.locked,
        lockNote: c.lockNote,
        weight: c.weight,
        outDx: c.outDx,
        outDy: c.outDy,
        inDx: c.inDx,
        inDy: c.inDy,
        requiresKeys: c.requires,
        labelKeys: c.labelIds
      }))
    });
  })
);

mapsRouter.patch(
  '/:mapId',
  ah(async (req, res) => {
    const mapId = uuid.parse(req.params.mapId);
    const body = mapUpdate.parse(req.body);
    /* null clears it; a non-null value must be a room on this very map */
    if (body.startLocationId) await assertLocationsOnMap(mapId, [body.startLocationId]);
    const stmt = updateSql(
      'maps',
      mapId,
      {
        name: body.name,
        description: body.description,
        start_location_id: body.startLocationId
      },
      '*'
    );
    const { rows } = stmt
      ? await query(stmt.text, stmt.values)
      : await query(`SELECT * FROM maps WHERE id = $1`, [mapId]);
    if (!rows.length) throw notFound('map');
    res.json(mapMap(rows[0]));
  })
);

mapsRouter.delete(
  '/:mapId',
  ah(async (req, res) => {
    const { rowCount } = await query(`DELETE FROM maps WHERE id = $1`, [
      uuid.parse(req.params.mapId)
    ]);
    if (!rowCount) throw notFound('map');
    res.status(204).end();
  })
);

mapsRouter.put(
  '/:mapId/positions',
  ah(async (req, res) => {
    const mapId = uuid.parse(req.params.mapId);
    const { positions, portalOffsets } = positionsUpdate.parse(req.body);
    if (!positions.length && !portalOffsets.length) return res.status(204).end();

    if (positions.length) {
      await query(
        `UPDATE locations AS l
            SET x = v.x, y = v.y
           FROM (SELECT * FROM unnest($2::uuid[], $3::float8[], $4::float8[]) AS t(id, x, y)) AS v
          WHERE l.id = v.id AND l.map_id = $1`,
        [mapId, positions.map((p) => p.id), positions.map((p) => p.x), positions.map((p) => p.y)]
      );
    }

    for (const side of ['out', 'in'] as const) {
      const rows = portalOffsets.filter((p) => p.side === side);
      if (!rows.length) continue;
      await query(
        `UPDATE connections AS c
            SET ${side}_dx = v.dx, ${side}_dy = v.dy
           FROM (SELECT * FROM unnest($2::uuid[], $3::float8[], $4::float8[]) AS t(id, dx, dy)) AS v
          WHERE c.id = v.id AND c.map_id = $1`,
        [mapId, rows.map((p) => p.connectionId), rows.map((p) => p.dx), rows.map((p) => p.dy)]
      );
    }

    res.status(204).end();
  })
);

mapsRouter.post(
  '/:mapId/reset-visited',
  ah(async (req, res) => {
    const { rowCount } = await query(
      `UPDATE locations SET visited = false WHERE map_id = $1 AND visited = true`,
      [uuid.parse(req.params.mapId)]
    );
    res.json({ cleared: rowCount ?? 0 });
  })
);

mapsRouter.post(
  '/import',
  ah(async (req, res) => {
    const body = graphImport.parse(req.body);

    /* unresolved *optional* references are reported, not silently dropped;
       unresolved *structural* references (endpoints) still hard-fail */
    const warnings: string[] = [];
    const warn = (what: string, key: string) => {
      if (warnings.length < 50) {
        warnings.push(`${what} "${key}" could not be resolved and was skipped`);
      }
    };

    const createdId = await withTransaction(async (client) => {
      const insert = async (table: string, row: Record<string, unknown>) => {
        const stmt = insertSql(table, row, 'id');
        const { rows } = await client.query(stmt.text, stmt.values);
        return rows[0].id as string;
      };

      const mapId = await insert('maps', { name: body.name, description: body.description });

      const groupIds = new Map<string, string>();
      for (const g of body.groups ?? []) {
        groupIds.set(
          g.key,
          await insert('groups', {
            map_id: mapId,
            name: g.name,
            color: g.color,
            text_color: g.textColor,
            notes: g.notes,
            display_style: g.displayStyle,
            body_padding: g.bodyPadding,
            default_kind: g.defaultKind,
            default_size: g.defaultSize,
            default_color: g.defaultColor,
            default_text_color: g.defaultTextColor,
            override_labels: g.overrideLabels
          })
        );
      }
      /* second pass: nesting, skipping anything that would be circular */
      for (const g of body.groups ?? []) {
        if (!g.parentKey) continue;
        const id = groupIds.get(g.key);
        if (!id) continue;
        const parent = groupIds.get(g.parentKey);
        if (!parent || parent === id) {
          warn('parent grouping', g.parentKey);
          continue;
        }
        await client.query(`UPDATE groups SET parent_id = $2 WHERE id = $1`, [id, parent]);
      }

      const locLabelIds = new Map<string, string>();
      /** Restart targets reference location keys, resolved once locations exist below. */
      const pendingLabelRestarts: Array<{ labelId: string; keys: string[] }> = [];
      for (const l of body.locationLabels ?? []) {
        const id = await insert('location_labels', {
          map_id: mapId,
          name: l.name,
          color: l.color,
          notes: l.notes,
          default_kind: l.defaultKind,
          default_size: l.defaultSize,
          default_color: l.defaultColor,
          default_text_color: l.defaultTextColor,
          override_groupings: l.overrideGroupings,
          restart_name: l.restartName,
          restart_weight: l.restartWeight
        });
        locLabelIds.set(l.key, id);
        if (l.restartTargetKeys?.length) {
          pendingLabelRestarts.push({ labelId: id, keys: l.restartTargetKeys });
        }
      }

      const connLabelIds = new Map<string, string>();
      /** Label requirements reference location keys, resolved once locations exist below. */
      const pendingLabelRequires: Array<{ labelId: string; keys: string[] }> = [];
      for (const l of body.connectionLabels ?? []) {
        const id = await insert('connection_labels', {
          map_id: mapId,
          name: l.name,
          color: l.color,
          notes: l.notes,
          default_color: l.defaultColor,
          default_text_color: l.defaultTextColor,
          default_travel_kind: l.defaultTravelKind,
          default_direction: l.defaultDirection,
          default_weight: l.defaultWeight,
          default_ephemeral: l.defaultEphemeral,
          default_locked: l.defaultLocked,
          default_lock_note: l.defaultLockNote
        });
        connLabelIds.set(l.key, id);
        if (l.defaultRequiresKeys?.length) {
          pendingLabelRequires.push({ labelId: id, keys: l.defaultRequiresKeys });
        }
      }

      /* one INSERT per row here would be 50,000 sequential round-trips on a
         maximal import — minutes, on one pooled connection, inside an open
         transaction (and past the reverse proxy's request timeout well before
         that). Ids are generated client-side so every row can be batched. */
      const locationIds = new Map<string, string>();
      const locationRows: unknown[][] = [];
      const locLabelAssignments: unknown[][] = [];
      /* membership order matters — [0] becomes the layout anchor — so these are
         inserted as individual statements (picking up the shared `seq` sequence
         in call order) rather than one batched INSERT, whose row order Postgres
         does not guarantee back into `added_at`/`seq` ties */
      const groupAssignments: Array<{ locationId: string; groupId: string }> = [];
      for (const loc of body.locations) {
        const id = randomUUID();
        locationIds.set(loc.key, id);
        locationRows.push([
          id,
          mapId,
          loc.name,
          loc.kind,
          loc.size,
          loc.notes,
          loc.color,
          loc.textColor,
          loc.visited,
          loc.x,
          loc.y,
          loc.coordX,
          loc.coordY,
          loc.coordZ
        ]);
        const keys = loc.groupKeys ?? (loc.groupKey ? [loc.groupKey] : []);
        const seen = new Set<string>();
        for (const key of keys) {
          const gid = groupIds.get(key);
          if (!gid) {
            warn('grouping', key);
            continue;
          }
          if (seen.has(gid)) continue;
          seen.add(gid);
          groupAssignments.push({ locationId: id, groupId: gid });
        }
        for (const key of loc.labelKeys ?? []) {
          const labelId = locLabelIds.get(key);
          if (!labelId) {
            warn('location label', key);
            continue;
          }
          locLabelAssignments.push([id, labelId]);
        }
      }
      await insertRows(
        client,
        'locations',
        [
          'id',
          'map_id',
          'name',
          'kind',
          'size',
          'notes',
          'color',
          'text_color',
          'visited',
          'x',
          'y',
          'coord_x',
          'coord_y',
          'coord_z'
        ],
        locationRows
      );
      for (const a of groupAssignments) {
        await client.query(
          `INSERT INTO location_group_assignments (location_id, group_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [a.locationId, a.groupId]
        );
      }
      await insertRows(
        client,
        'location_label_assignments',
        ['location_id', 'label_id'],
        locLabelAssignments,
        'ON CONFLICT DO NOTHING'
      );

      const resolveLocations = (keys: string[] | undefined, what: string) => {
        const out: string[] = [];
        for (const key of keys ?? []) {
          const id = locationIds.get(key);
          if (id) out.push(id);
          else warn(what, key);
        }
        return out;
      };

      for (const { labelId, keys } of pendingLabelRequires) {
        const ids = resolveLocations(keys, 'label unlock condition');
        if (ids.length) await replaceRequirements(client, 'label', labelId, ids);
      }

      for (const { labelId, keys } of pendingLabelRestarts) {
        const ids = resolveLocations(keys, 'restart target');
        if (ids.length) await replaceRestartTargets(client, labelId, ids);
      }

      if (body.startLocationKey) {
        const startId = locationIds.get(body.startLocationKey);
        if (startId) {
          await client.query(`UPDATE maps SET start_location_id = $2 WHERE id = $1`, [mapId, startId]);
        } else {
          warn('default trip start', body.startLocationKey);
        }
      }

      const connectionRows: unknown[][] = [];
      const connLabelAssignments: unknown[][] = [];
      /* connection_requirements is a many-to-many; batched the same way
         `replaceRequirements` already does it (one unnest INSERT), just
         accumulated across every connection instead of one round-trip each */
      const requirementRows: unknown[][] = [];
      for (const conn of body.connections) {
        const src = locationIds.get(conn.sourceKey);
        const tgt = locationIds.get(conn.targetKey);
        if (!src || !tgt) throw badRequest('unknown connection endpoint key');

        const id = randomUUID();
        connectionRows.push([
          id,
          mapId,
          src,
          tgt,
          conn.name,
          conn.notes,
          conn.travelKind,
          conn.color,
          conn.textColor,
          conn.arrowSource,
          conn.arrowTarget,
          conn.ephemeral,
          conn.locked,
          conn.lockNote,
          conn.weight,
          conn.outDx,
          conn.outDy,
          conn.inDx,
          conn.inDy
        ]);

        const reqIds = resolveLocations(conn.requiresKeys, 'unlock condition');
        for (const locId of new Set(reqIds)) requirementRows.push([id, locId]);

        for (const key of conn.labelKeys ?? []) {
          const labelId = connLabelIds.get(key);
          if (!labelId) {
            warn('connection label', key);
            continue;
          }
          connLabelAssignments.push([id, labelId]);
        }
      }
      await insertRows(
        client,
        'connections',
        [
          'id',
          'map_id',
          'source_id',
          'target_id',
          'name',
          'notes',
          'travel_kind',
          'color',
          'text_color',
          'arrow_source',
          'arrow_target',
          'ephemeral',
          'locked',
          'lock_note',
          'weight',
          'out_dx',
          'out_dy',
          'in_dx',
          'in_dy'
        ],
        connectionRows
      );
      await insertRows(
        client,
        'connection_requirements',
        ['connection_id', 'location_id'],
        requirementRows,
        'ON CONFLICT DO NOTHING'
      );
      await insertRows(
        client,
        'connection_label_assignments',
        ['connection_id', 'label_id'],
        connLabelAssignments,
        'ON CONFLICT DO NOTHING'
      );

      return mapId;
    });

    const graph = await loadGraph(createdId);
    res.status(201).json({ ...graph, warnings });
  })
);
