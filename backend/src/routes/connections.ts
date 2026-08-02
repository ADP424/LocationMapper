import { Router } from 'express';
import { query, withTransaction } from '../db';
import { ah, notFound } from '../http';
import { assertLocationsOnMap, fetchConnection, mapIdOf, replaceRequirements } from '../repo';
import { insertSql, updateSql } from '../sql';
import { connectionCreate, connectionUpdate, uuid } from '../validation';

export const connectionsRouter = Router();

const columns = (b: ReturnType<typeof connectionUpdate.parse>) => ({
  source_id: b.sourceId,
  target_id: b.targetId,
  name: b.name,
  notes: b.notes,
  travel_kind: b.travelKind,
  color: b.color,
  text_color: b.textColor,
  arrow_source: b.arrowSource,
  arrow_target: b.arrowTarget,
  ephemeral: b.ephemeral,
  locked: b.locked,
  lock_note: b.lockNote,
  weight: b.weight,
  out_dx: b.outDx,
  out_dy: b.outDy,
  in_dx: b.inDx,
  in_dy: b.inDy
});

connectionsRouter.post(
  '/maps/:mapId/connections',
  ah(async (req, res) => {
    const mapId = uuid.parse(req.params.mapId);
    const b = connectionCreate.parse(req.body);
    await assertLocationsOnMap(mapId, [b.sourceId, b.targetId, ...(b.requires ?? [])]);

    const id = await withTransaction(async (client) => {
      const stmt = insertSql('connections', { map_id: mapId, ...columns(b) }, 'id');
      const { rows } = await client.query(stmt.text, stmt.values);
      const id = rows[0].id as string;
      if (b.requires?.length) await replaceRequirements(client, 'connection', id, b.requires);
      return id;
    });

    res.status(201).json(await fetchConnection(id));
  })
);

connectionsRouter.get(
  '/connections/:id',
  ah(async (req, res) => {
    res.json(await fetchConnection(uuid.parse(req.params.id)));
  })
);

connectionsRouter.patch(
  '/connections/:id',
  ah(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const b = connectionUpdate.parse(req.body);
    const mapId = await mapIdOf('connections', id);

    await assertLocationsOnMap(mapId, [
      ...(b.sourceId ? [b.sourceId] : []),
      ...(b.targetId ? [b.targetId] : []),
      ...(b.requires ?? [])
    ]);

    await withTransaction(async (client) => {
      const stmt = updateSql('connections', id, columns(b));
      if (stmt) await client.query(stmt.text, stmt.values);
      if (b.requires) await replaceRequirements(client, 'connection', id, b.requires);
    });

    res.json(await fetchConnection(id));
  })
);

connectionsRouter.delete(
  '/connections/:id',
  ah(async (req, res) => {
    const { rowCount } = await query(`DELETE FROM connections WHERE id = $1`, [
      uuid.parse(req.params.id)
    ]);
    if (!rowCount) throw notFound('connection');
    res.status(204).end();
  })
);
