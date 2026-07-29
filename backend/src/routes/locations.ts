import { Router } from 'express';
import { query } from '../db';
import { ah, badRequest, notFound } from '../http';
import { fetchLocation } from '../repo';
import { locationCreate, locationUpdate, uuid } from '../validation';

export const locationsRouter = Router();

async function assertGroupInMap(groupId: string, mapId: string) {
  const { rows } = await query(`SELECT map_id FROM groups WHERE id = $1`, [groupId]);
  if (!rows.length) throw notFound('group');
  if (rows[0].map_id !== mapId) throw badRequest('group belongs to a different map');
}

locationsRouter.post(
  '/maps/:mapId/locations',
  ah(async (req, res) => {
    const mapId = uuid.parse(req.params.mapId);
    const body = locationCreate.parse(req.body);

    const exists = await query(`SELECT 1 FROM maps WHERE id = $1`, [mapId]);
    if (!exists.rowCount) throw notFound('map');
    if (body.groupId) await assertGroupInMap(body.groupId, mapId);

    const { rows } = await query(
      `INSERT INTO locations
         (map_id, group_id, name, kind, layer, notes, color, text_color, visited, pinned, x, y,
          coord_x, coord_y, coord_z)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        mapId,
        body.groupId ?? null,
        body.name ?? '',
        body.kind ?? 'round-rectangle',
        body.layer ?? '',
        body.notes ?? '',
        body.color ?? '',
        body.textColor ?? '',
        body.visited ?? false,
        body.pinned ?? false,
        body.x ?? null,
        body.y ?? null,
        body.coordX ?? null,
        body.coordY ?? null,
        body.coordZ ?? null
      ]
    );
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

    const current = await query(`SELECT map_id FROM locations WHERE id = $1`, [id]);
    if (!current.rowCount) throw notFound('location');
    if (b.groupId) await assertGroupInMap(b.groupId, current.rows[0].map_id);

    /* `groupId: null` explicitly clears membership; omitting it leaves it alone. */
    const clearGroup =
      Object.prototype.hasOwnProperty.call(req.body ?? {}, 'groupId') && b.groupId === null;
    /* explicit nulls clear a coordinate; omitting the key leaves it alone */
    const had = (k: string) => Object.prototype.hasOwnProperty.call(req.body ?? {}, k);
    const clearX = had('coordX') && b.coordX === null;
    const clearY = had('coordY') && b.coordY === null;
    const clearZ = had('coordZ') && b.coordZ === null;

    await query(
      `UPDATE locations SET
          name       = COALESCE($2::text, name),
          kind       = COALESCE($3::text, kind),
          layer      = COALESCE($4::text, layer),
          notes      = COALESCE($5::text, notes),
          color      = COALESCE($6::text, color),
          text_color = COALESCE($7::text, text_color),
          visited    = COALESCE($8::boolean, visited),
          pinned     = COALESCE($9::boolean, pinned),
          x          = COALESCE($10::float8, x),
          y          = COALESCE($11::float8, y),
          group_id   = CASE WHEN $13::boolean THEN NULL
                            ELSE COALESCE($12::uuid, group_id) END,
          coord_x    = CASE WHEN $15::boolean THEN NULL ELSE COALESCE($14::int, coord_x) END,
          coord_y    = CASE WHEN $17::boolean THEN NULL ELSE COALESCE($16::int, coord_y) END,
          coord_z    = CASE WHEN $19::boolean THEN NULL ELSE COALESCE($18::int, coord_z) END
        WHERE id = $1`,
      [
        id,
        b.name ?? null,
        b.kind ?? null,
        b.layer ?? null,
        b.notes ?? null,
        b.color ?? null,
        b.textColor ?? null,
        b.visited ?? null,
        b.pinned ?? null,
        b.x ?? null,
        b.y ?? null,
        b.groupId ?? null,
        clearGroup,
        b.coordX ?? null, clearX,
        b.coordY ?? null, clearY,
        b.coordZ ?? null, clearZ
      ]
    );
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
