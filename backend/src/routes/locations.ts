import { Router } from 'express';
import { query } from '../db';
import { ah, notFound } from '../http';
import { mapLocation } from '../mappers';
import { locationCreate, locationUpdate, uuid } from '../validation';

export const locationsRouter = Router();

locationsRouter.post(
  '/maps/:mapId/locations',
  ah(async (req, res) => {
    const mapId = uuid.parse(req.params.mapId);
    const body = locationCreate.parse(req.body);

    const exists = await query(`SELECT 1 FROM maps WHERE id = $1`, [mapId]);
    if (!exists.rowCount) throw notFound('map');

    const { rows } = await query(
      `INSERT INTO locations
         (map_id, name, kind, layer, notes, color, text_color, visited, pinned, x, y)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        mapId,
        body.name ?? '',
        body.kind ?? 'round-rectangle',
        body.layer ?? '',
        body.notes ?? '',
        body.color ?? '',
        body.textColor ?? '',
        body.visited ?? false,
        body.pinned ?? false,
        body.x ?? null,
        body.y ?? null
      ]
    );
    res.status(201).json(mapLocation(rows[0]));
  })
);

locationsRouter.get(
  '/locations/:id',
  ah(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { rows } = await query(`SELECT * FROM locations WHERE id = $1`, [id]);
    if (!rows.length) throw notFound('location');
    res.json(mapLocation(rows[0]));
  })
);

locationsRouter.patch(
  '/locations/:id',
  ah(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const b = locationUpdate.parse(req.body);
    const { rows } = await query(
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
          y          = COALESCE($11::float8, y)
        WHERE id = $1
        RETURNING *`,
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
        b.y ?? null
      ]
    );
    if (!rows.length) throw notFound('location');
    res.json(mapLocation(rows[0]));
  })
);

locationsRouter.delete(
  '/locations/:id',
  ah(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const { rowCount } = await query(`DELETE FROM locations WHERE id = $1`, [id]);
    if (!rowCount) throw notFound('location');
    res.status(204).end();
  })
);
