import { Router } from 'express';
import { query } from '../db';
import { ah, notFound } from '../http';
import { assertGroupOnMap, assertMapExists, fetchLocation, mapIdOf } from '../repo';
import { insertSql, updateSql } from '../sql';
import { locationCreate, locationUpdate, uuid } from '../validation';

export const locationsRouter = Router();

/** Request body -> column names. `undefined` leaves a column alone, `null` clears it. */
const columns = (b: ReturnType<typeof locationCreate.parse>) => ({
  name: b.name,
  kind: b.kind,
  size: b.size,
  notes: b.notes,
  color: b.color,
  text_color: b.textColor,
  visited: b.visited,
  x: b.x,
  y: b.y,
  group_id: b.groupId,
  coord_x: b.coordX,
  coord_y: b.coordY,
  coord_z: b.coordZ
});

locationsRouter.post(
  '/maps/:mapId/locations',
  ah(async (req, res) => {
    const mapId = uuid.parse(req.params.mapId);
    const b = locationCreate.parse(req.body);
    await assertMapExists(mapId);
    if (b.groupId) await assertGroupOnMap(b.groupId, mapId);

    const stmt = insertSql('locations', { map_id: mapId, ...columns(b) }, 'id');
    const { rows } = await query(stmt.text, stmt.values);
    res.status(201).json(await fetchLocation(rows[0].id));
  })
);

locationsRouter.get(
  '/locations/:id',
  ah(async (req, res) => {
    res.json(await fetchLocation(uuid.parse(req.params.id)));
  })
);

locationsRouter.patch(
  '/locations/:id',
  ah(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const b = locationUpdate.parse(req.body);
    const mapId = await mapIdOf('locations', id);
    if (b.groupId) await assertGroupOnMap(b.groupId, mapId);

    const stmt = updateSql('locations', id, columns(b));
    if (stmt) await query(stmt.text, stmt.values);
    res.json(await fetchLocation(id));
  })
);

locationsRouter.delete(
  '/locations/:id',
  ah(async (req, res) => {
    const { rowCount } = await query(`DELETE FROM locations WHERE id = $1`, [
      uuid.parse(req.params.id)
    ]);
    if (!rowCount) throw notFound('location');
    res.status(204).end();
  })
);
