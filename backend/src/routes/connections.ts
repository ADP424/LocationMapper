import { Router } from 'express';
import { query, withTransaction } from '../db';
import { ah, badRequest, notFound } from '../http';
import { mapConnection } from '../mappers';
import { connectionCreate, connectionUpdate, uuid } from '../validation';

export const connectionsRouter = Router();

async function readConnection(id: string) {
  const { rows } = await query(
    `SELECT c.*,
            COALESCE(array_agg(r.location_id) FILTER (WHERE r.location_id IS NOT NULL), '{}') AS requires
       FROM connections c
       LEFT JOIN connection_requirements r ON r.connection_id = c.id
      WHERE c.id = $1
      GROUP BY c.id`,
    [id]
  );
  if (!rows.length) throw notFound('connection');
  return mapConnection(rows[0]);
}

async function assertSameMap(mapId: string, locationIds: string[]) {
  const unique = [...new Set(locationIds)];
  if (!unique.length) return;
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM locations WHERE map_id = $1 AND id = ANY($2::uuid[])`,
    [mapId, unique]
  );
  if (rows[0].n !== unique.length) {
    throw badRequest('all referenced locations must belong to the same map');
  }
}

connectionsRouter.post(
  '/maps/:mapId/connections',
  ah(async (req, res) => {
    const mapId = uuid.parse(req.params.mapId);
    const b = connectionCreate.parse(req.body);

    await assertSameMap(mapId, [b.sourceId, b.targetId, ...(b.requires ?? [])]);

    const created = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO connections
           (map_id, source_id, target_id, name, notes, travel_kind, color, text_color,
            arrow_source, arrow_target, ephemeral, locked, lock_note, weight)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING id`,
        [
          mapId,
          b.sourceId,
          b.targetId,
          b.name ?? '',
          b.notes ?? '',
          b.travelKind ?? 'solid',
          b.color ?? '',
          b.textColor ?? '',
          b.arrowSource ?? false,
          b.arrowTarget ?? true,
          b.ephemeral ?? false,
          b.locked ?? false,
          b.lockNote ?? '',
          b.weight ?? 1
        ]
      );
      const id = rows[0].id as string;
      for (const locId of b.requires ?? []) {
        await client.query(
          `INSERT INTO connection_requirements (connection_id, location_id)
           VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [id, locId]
        );
      }
      return id;
    });

    res.status(201).json(await readConnection(created));
  })
);

connectionsRouter.get(
  '/connections/:id',
  ah(async (req, res) => {
    res.json(await readConnection(uuid.parse(req.params.id)));
  })
);

connectionsRouter.patch(
  '/connections/:id',
  ah(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const b = connectionUpdate.parse(req.body);

    const existing = await query(`SELECT map_id FROM connections WHERE id = $1`, [id]);
    if (!existing.rowCount) throw notFound('connection');
    const mapId = existing.rows[0].map_id as string;

    await assertSameMap(mapId, [
      ...(b.sourceId ? [b.sourceId] : []),
      ...(b.targetId ? [b.targetId] : []),
      ...(b.requires ?? [])
    ]);

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE connections SET
            source_id    = COALESCE($2::uuid, source_id),
            target_id    = COALESCE($3::uuid, target_id),
            name         = COALESCE($4::text, name),
            notes        = COALESCE($5::text, notes),
            travel_kind  = COALESCE($6::text, travel_kind),
            color        = COALESCE($7::text, color),
            text_color   = COALESCE($8::text, text_color),
            arrow_source = COALESCE($9::boolean, arrow_source),
            arrow_target = COALESCE($10::boolean, arrow_target),
            ephemeral    = COALESCE($11::boolean, ephemeral),
            locked       = COALESCE($12::boolean, locked),
            lock_note    = COALESCE($13::text, lock_note),
            weight       = COALESCE($14::float8, weight)
          WHERE id = $1`,
        [
          id,
          b.sourceId ?? null,
          b.targetId ?? null,
          b.name ?? null,
          b.notes ?? null,
          b.travelKind ?? null,
          b.color ?? null,
          b.textColor ?? null,
          b.arrowSource ?? null,
          b.arrowTarget ?? null,
          b.ephemeral ?? null,
          b.locked ?? null,
          b.lockNote ?? null,
          b.weight ?? null
        ]
      );

      if (b.requires) {
        await client.query(`DELETE FROM connection_requirements WHERE connection_id = $1`, [id]);
        for (const locId of b.requires) {
          await client.query(
            `INSERT INTO connection_requirements (connection_id, location_id)
             VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [id, locId]
          );
        }
      }
    });

    res.json(await readConnection(id));
  })
);

connectionsRouter.delete(
  '/connections/:id',
  ah(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { rowCount } = await query(`DELETE FROM connections WHERE id = $1`, [id]);
    if (!rowCount) throw notFound('connection');
    res.status(204).end();
  })
);
