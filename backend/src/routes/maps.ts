import { Router } from 'express';
import { query, withTransaction } from '../db';
import { ah, badRequest, notFound } from '../http';
import { mapConnection, mapLocation, mapMap, mapMapSummary } from '../mappers';
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

  const locRes = await query(
    `SELECT * FROM locations WHERE map_id = $1 ORDER BY created_at`,
    [mapId]
  );

  const connRes = await query(
    `SELECT c.*,
            COALESCE(array_agg(r.location_id) FILTER (WHERE r.location_id IS NOT NULL), '{}') AS requires
       FROM connections c
       LEFT JOIN connection_requirements r ON r.connection_id = c.id
      WHERE c.map_id = $1
      GROUP BY c.id
      ORDER BY c.created_at`,
    [mapId]
  );

  return {
    map: mapMap(mapRes.rows[0]),
    locations: locRes.rows.map(mapLocation),
    connections: connRes.rows.map(mapConnection)
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
      locations: graph.locations.map((l) => ({
        key: l.id,
        name: l.name,
        kind: l.kind,
        layer: l.layer,
        notes: l.notes,
        color: l.color,
        textColor: l.textColor,
        visited: l.visited,
        pinned: l.pinned,
        x: l.x,
        y: l.y
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
        requiresKeys: c.requires
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
    const { positions } = positionsUpdate.parse(req.body);
    if (!positions.length) return res.status(204).end();

    await query(
      `UPDATE locations AS l
          SET x = v.x, y = v.y
         FROM (
           SELECT * FROM unnest($2::uuid[], $3::float8[], $4::float8[]) AS t(id, x, y)
         ) AS v
        WHERE l.id = v.id AND l.map_id = $1`,
      [mapId, positions.map((p) => p.id), positions.map((p) => p.x), positions.map((p) => p.y)]
    );
    res.status(204).end();
  })
);

mapsRouter.post(
  '/import',
  ah(async (req, res) => {
    const body = graphImport.parse(req.body);

    const createdId = await withTransaction(async (client) => {
      const mapRes = await client.query(
        `INSERT INTO maps (name, description) VALUES ($1, $2) RETURNING id`,
        [body.name, body.description ?? '']
      );
      const mapId = mapRes.rows[0].id as string;
      const keyToId = new Map<string, string>();

      for (const loc of body.locations) {
        const r = await client.query(
          `INSERT INTO locations
             (map_id, name, kind, layer, notes, color, text_color, visited, pinned, x, y)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [
            mapId,
            loc.name ?? '',
            loc.kind ?? 'round-rectangle',
            loc.layer ?? '',
            loc.notes ?? '',
            loc.color ?? '',
            loc.textColor ?? '',
            loc.visited ?? false,
            loc.pinned ?? false,
            loc.x ?? null,
            loc.y ?? null
          ]
        );
        keyToId.set(loc.key, r.rows[0].id);
      }

      for (const conn of body.connections) {
        const src = keyToId.get(conn.sourceKey);
        const tgt = keyToId.get(conn.targetKey);
        if (!src || !tgt) throw badRequest('unknown connection endpoint key');
        const r = await client.query(
          `INSERT INTO connections
             (map_id, source_id, target_id, name, notes, travel_kind, color, text_color,
              arrow_source, arrow_target, ephemeral, locked, lock_note, weight)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
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
            conn.weight ?? 1
          ]
        );
        for (const reqKey of conn.requiresKeys ?? []) {
          const reqId = keyToId.get(reqKey);
          if (!reqId) continue;
          await client.query(
            `INSERT INTO connection_requirements (connection_id, location_id)
             VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [r.rows[0].id, reqId]
          );
        }
      }
      return mapId;
    });

    res.status(201).json(await loadGraph(createdId));
  })
);
