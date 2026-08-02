import { Router } from 'express';
import { query, withTransaction } from '../db';
import { ah, badRequest, notFound } from '../http';
import { mapGroup, mapMap, mapMapSummary } from '../mappers';
import {
  fetchConnectionLabels,
  fetchConnections,
  fetchLocationLabels,
  fetchLocations,
  replaceRequirements
} from '../repo';
import { insertSql, updateSql } from '../sql';
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
      groups: graph.groups.map((g) => ({
        key: g.id,
        parentKey: g.parentId,
        name: g.name,
        color: g.color,
        textColor: g.textColor,
        notes: g.notes
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
        defaultLayer: l.defaultLayer,
        defaultGroupKey: l.defaultGroupId
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
        groupKey: l.groupId,
        name: l.name,
        kind: l.kind,
        size: l.size,
        layer: l.layer,
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
    const stmt = updateSql('maps', mapId, { name: body.name, description: body.description }, '*');
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
            notes: g.notes
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
      for (const l of body.locationLabels ?? []) {
        locLabelIds.set(
          l.key,
          await insert('location_labels', {
            map_id: mapId,
            name: l.name,
            color: l.color,
            notes: l.notes,
            default_kind: l.defaultKind,
            default_size: l.defaultSize,
            default_color: l.defaultColor,
            default_text_color: l.defaultTextColor,
            default_layer: l.defaultLayer,
            default_group_id: l.defaultGroupKey ? groupIds.get(l.defaultGroupKey) ?? null : null
          })
        );
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

      const locationIds = new Map<string, string>();
      for (const loc of body.locations) {
        const id = await insert('locations', {
          map_id: mapId,
          group_id: loc.groupKey ? groupIds.get(loc.groupKey) ?? null : null,
          name: loc.name,
          kind: loc.kind,
          size: loc.size,
          layer: loc.layer,
          notes: loc.notes,
          color: loc.color,
          text_color: loc.textColor,
          visited: loc.visited,
          x: loc.x,
          y: loc.y,
          coord_x: loc.coordX,
          coord_y: loc.coordY,
          coord_z: loc.coordZ
        });
        locationIds.set(loc.key, id);

        for (const key of loc.labelKeys ?? []) {
          const labelId = locLabelIds.get(key);
          if (!labelId) {
            warn('location label', key);
            continue;
          }
          await client.query(
            `INSERT INTO location_label_assignments (location_id, label_id)
             VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [id, labelId]
          );
        }
      }

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

      for (const conn of body.connections) {
        const src = locationIds.get(conn.sourceKey);
        const tgt = locationIds.get(conn.targetKey);
        if (!src || !tgt) throw badRequest('unknown connection endpoint key');

        const id = await insert('connections', {
          map_id: mapId,
          source_id: src,
          target_id: tgt,
          name: conn.name,
          notes: conn.notes,
          travel_kind: conn.travelKind,
          color: conn.color,
          text_color: conn.textColor,
          arrow_source: conn.arrowSource,
          arrow_target: conn.arrowTarget,
          ephemeral: conn.ephemeral,
          locked: conn.locked,
          lock_note: conn.lockNote,
          weight: conn.weight,
          out_dx: conn.outDx,
          out_dy: conn.outDy,
          in_dx: conn.inDx,
          in_dy: conn.inDy
        });

        const reqIds = resolveLocations(conn.requiresKeys, 'unlock condition');
        if (reqIds.length) await replaceRequirements(client, 'connection', id, reqIds);

        for (const key of conn.labelKeys ?? []) {
          const labelId = connLabelIds.get(key);
          if (!labelId) {
            warn('connection label', key);
            continue;
          }
          await client.query(
            `INSERT INTO connection_label_assignments (connection_id, label_id)
             VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [id, labelId]
          );
        }
      }

      return mapId;
    });

    const graph = await loadGraph(createdId);
    res.status(201).json({ ...graph, warnings });
  })
);
