import { Router } from 'express';
import { query, withTransaction } from '../db';
import { ah, badRequest, notFound } from '../http';
import { mapGroup, mapMap, mapMapSummary } from '../mappers';
import {
  fetchConnectionLabels,
  fetchConnections,
  fetchLocationLabels,
  fetchLocations
} from '../repo';
import { graphImport, mapCreate, mapUpdate, positionsUpdate, uuid } from '../validation';
import type { GraphPayload } from '../types';

export const mapsRouter = Router();

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

export async function loadGraph(mapId: string): Promise<GraphPayload> {
  const mapRes = await query(`SELECT * FROM maps WHERE id = $1`, [mapId]);
  if (!mapRes.rows.length) throw notFound('map');

  const groupRes = await query(`SELECT * FROM groups WHERE map_id = $1 ORDER BY created_at`, [
    mapId
  ]);

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
        layer: l.layer,
        notes: l.notes,
        color: l.color,
        textColor: l.textColor,
        visited: l.visited,
        pinned: l.pinned,
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
    const { rows } = await query(
      `UPDATE maps
          SET name        = COALESCE($2::text, name),
              description = COALESCE($3::text, description)
        WHERE id = $1
        RETURNING *`,
      [mapId, body.name ?? null, body.description ?? null]
    );
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
    const mapId = uuid.parse(req.params.mapId);
    const { rowCount } = await query(
      `UPDATE locations SET visited = false WHERE map_id = $1 AND visited = true`,
      [mapId]
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
      if (warnings.length < 50) warnings.push(`${what} "${key}" could not be resolved and was skipped`);
    };

    const createdId = await withTransaction(async (client) => {
      const mapRes = await client.query(
        `INSERT INTO maps (name, description) VALUES ($1, $2) RETURNING id`,
        [body.name, body.description ?? '']
      );
      const mapId = mapRes.rows[0].id as string;

      const groupKeyToId = new Map<string, string>();
      for (const g of body.groups ?? []) {
        const r = await client.query(
          `INSERT INTO groups (map_id, name, color, text_color, notes)
           VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [mapId, g.name ?? '', g.color ?? '', g.textColor ?? '', g.notes ?? '']
        );
        groupKeyToId.set(g.key, r.rows[0].id);
      }
      /* second pass: nesting, skipping anything that would be circular */
      for (const g of body.groups ?? []) {
        if (!g.parentKey) continue;
        const id = groupKeyToId.get(g.key);
        const parent = groupKeyToId.get(g.parentKey);
        if (!id) continue;
        if (!parent || id === parent) {
          warn('parent grouping', g.parentKey);
          continue;
        }
        await client.query(`UPDATE groups SET parent_id = $2 WHERE id = $1`, [id, parent]);
      }

      /* labels next: their defaults may reference groups, their requirements
         and assignments reference locations/connections created below */
      const locLabelKeyToId = new Map<string, string>();
      for (const l of body.locationLabels ?? []) {
        const r = await client.query(
          `INSERT INTO location_labels
             (map_id, name, color, notes, default_kind, default_color, default_text_color,
              default_layer, default_group_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [
            mapId,
            l.name ?? '',
            l.color ?? '',
            l.notes ?? '',
            l.defaultKind ?? '',
            l.defaultColor ?? '',
            l.defaultTextColor ?? '',
            l.defaultLayer ?? '',
            l.defaultGroupKey ? groupKeyToId.get(l.defaultGroupKey) ?? null : null
          ]
        );
        locLabelKeyToId.set(l.key, r.rows[0].id);
      }

      const connLabelKeyToId = new Map<string, string>();
      /** Label requirements reference location keys, resolved once locations exist below. */
      const pendingLabelRequires: Array<{ labelId: string; keys: string[] }> = [];
      for (const l of body.connectionLabels ?? []) {
        const r = await client.query(
          `INSERT INTO connection_labels
             (map_id, name, color, notes, default_color, default_text_color, default_travel_kind,
              default_direction, default_weight, default_ephemeral, default_locked, default_lock_note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
          [
            mapId,
            l.name ?? '',
            l.color ?? '',
            l.notes ?? '',
            l.defaultColor ?? '',
            l.defaultTextColor ?? '',
            l.defaultTravelKind ?? '',
            l.defaultDirection ?? '',
            l.defaultWeight ?? null,
            l.defaultEphemeral ?? null,
            l.defaultLocked ?? null,
            l.defaultLockNote ?? ''
          ]
        );
        connLabelKeyToId.set(l.key, r.rows[0].id);
        if (l.defaultRequiresKeys?.length) {
          pendingLabelRequires.push({ labelId: r.rows[0].id, keys: l.defaultRequiresKeys });
        }
      }

      const keyToId = new Map<string, string>();
      for (const loc of body.locations) {
        const groupId = loc.groupKey ? groupKeyToId.get(loc.groupKey) ?? null : null;
        const r = await client.query(
          `INSERT INTO locations
             (map_id, group_id, name, kind, layer, notes, color, text_color, visited, pinned, x, y,
              coord_x, coord_y, coord_z)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
          [
            mapId,
            groupId,
            loc.name ?? '',
            loc.kind ?? 'round-rectangle',
            loc.layer ?? '',
            loc.notes ?? '',
            loc.color ?? '',
            loc.textColor ?? '',
            loc.visited ?? false,
            loc.pinned ?? false,
            loc.x ?? null,
            loc.y ?? null,
            loc.coordX ?? null,
            loc.coordY ?? null,
            loc.coordZ ?? null
          ]
        );
        keyToId.set(loc.key, r.rows[0].id);
        for (const labelKey of loc.labelKeys ?? []) {
          const labelId = locLabelKeyToId.get(labelKey);
          if (!labelId) { warn('location label', labelKey); continue; }
          await client.query(
            `INSERT INTO location_label_assignments (location_id, label_id)
             VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [r.rows[0].id, labelId]
          );
        }
      }

      for (const { labelId, keys } of pendingLabelRequires) {
        for (const key of keys) {
          const locId = keyToId.get(key);
          if (!locId) { warn('label unlock condition', key); continue; }
          await client.query(
            `INSERT INTO connection_label_requirements (label_id, location_id)
             VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [labelId, locId]
          );
        }
      }

      for (const conn of body.connections) {
        const src = keyToId.get(conn.sourceKey);
        const tgt = keyToId.get(conn.targetKey);
        if (!src || !tgt) throw badRequest('unknown connection endpoint key');
        const r = await client.query(
          `INSERT INTO connections
             (map_id, source_id, target_id, name, notes, travel_kind, color, text_color,
              arrow_source, arrow_target, ephemeral, locked, lock_note, weight,
              out_dx, out_dy, in_dx, in_dy)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
          [
            mapId,
            src,
            tgt,
            conn.name ?? '',
            conn.notes ?? '',
            conn.travelKind ?? 'solid',
            conn.color ?? '',
            conn.textColor ?? '',
            conn.arrowSource ?? false,
            conn.arrowTarget ?? true,
            conn.ephemeral ?? false,
            conn.locked ?? false,
            conn.lockNote ?? '',
            conn.weight ?? 1,
            conn.outDx ?? null,
            conn.outDy ?? null,
            conn.inDx ?? null,
            conn.inDy ?? null
          ]
        );
        for (const reqKey of conn.requiresKeys ?? []) {
          const reqId = keyToId.get(reqKey);
          if (!reqId) { warn('unlock condition', reqKey); continue; }
          await client.query(
            `INSERT INTO connection_requirements (connection_id, location_id)
             VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [r.rows[0].id, reqId]
          );
        }
        for (const labelKey of conn.labelKeys ?? []) {
          const labelId = connLabelKeyToId.get(labelKey);
          if (!labelId) { warn('connection label', labelKey); continue; }
          await client.query(
            `INSERT INTO connection_label_assignments (connection_id, label_id)
             VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [r.rows[0].id, labelId]
          );
        }
      }
      return mapId;
    });

    const graph = await loadGraph(createdId);
    res.status(201).json({ ...graph, warnings });
  })
);
