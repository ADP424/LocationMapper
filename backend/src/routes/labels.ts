import { Router } from 'express';
import { query, withTransaction } from '../db';
import { ah, badRequest, notFound } from '../http';
import { applyConnectionLabel, applyLocationLabel } from '../labelStyling';
import { mapLocationLabel } from '../mappers';
import {
  assertLocationsOnMap,
  fetchConnection,
  fetchConnectionLabel,
  fetchConnectionsByLabel,
  fetchLocation,
  fetchLocationLabel,
  fetchLocationsByLabel,
  mapIdOf
} from '../repo';
import {
  connectionLabelCreate,
  connectionLabelUpdate,
  labelAssign,
  locationLabelCreate,
  locationLabelUpdate,
  uuid
} from '../validation';

export const labelsRouter = Router();

/* ============================================================ location labels */
labelsRouter.post(
  '/maps/:mapId/location-labels',
  ah(async (req, res) => {
    const mapId = uuid.parse(req.params.mapId);
    const b = locationLabelCreate.parse(req.body);
    if (b.defaultGroupId && (await mapIdOf('groups', b.defaultGroupId)) !== mapId) {
      throw badRequest('the default grouping belongs to a different map');
    }
    const { rows } = await query(
      `INSERT INTO location_labels
         (map_id, name, color, notes, default_kind, default_color, default_text_color,
          default_layer, default_group_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        mapId,
        b.name ?? 'New Label',
        b.color ?? '',
        b.notes ?? '',
        b.defaultKind ?? '',
        b.defaultColor ?? '',
        b.defaultTextColor ?? '',
        b.defaultLayer ?? '',
        b.defaultGroupId ?? null
      ]
    );
    res.status(201).json(mapLocationLabel(rows[0]));
  })
);

labelsRouter.patch(
  '/location-labels/:id',
  ah(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const b = locationLabelUpdate.parse(req.body);
    const mapId = await mapIdOf('location_labels', id);
    if (b.defaultGroupId && (await mapIdOf('groups', b.defaultGroupId)) !== mapId) {
      throw badRequest('the default grouping belongs to a different map');
    }
    const clearGroup =
      Object.prototype.hasOwnProperty.call(req.body ?? {}, 'defaultGroupId') &&
      b.defaultGroupId === null;

    await query(
      `UPDATE location_labels SET
          name               = COALESCE($2::text, name),
          color              = COALESCE($3::text, color),
          notes              = COALESCE($4::text, notes),
          default_kind       = COALESCE($5::text, default_kind),
          default_color      = COALESCE($6::text, default_color),
          default_text_color = COALESCE($7::text, default_text_color),
          default_layer      = COALESCE($8::text, default_layer),
          default_group_id   = CASE WHEN $10::boolean THEN NULL
                                    ELSE COALESCE($9::uuid, default_group_id) END
        WHERE id = $1`,
      [
        id,
        b.name ?? null,
        b.color ?? null,
        b.notes ?? null,
        b.defaultKind ?? null,
        b.defaultColor ?? null,
        b.defaultTextColor ?? null,
        b.defaultLayer ?? null,
        b.defaultGroupId ?? null,
        clearGroup
      ]
    );
    res.json(await fetchLocationLabel(id));
  })
);

labelsRouter.delete(
  '/location-labels/:id',
  ah(async (req, res) => {
    const { rowCount } = await query(`DELETE FROM location_labels WHERE id = $1`, [
      uuid.parse(req.params.id)
    ]);
    if (!rowCount) throw notFound('location label');
    res.status(204).end();
  })
);

/** Re-stamp the label's current defaults onto every location that carries it. */
labelsRouter.post(
  '/location-labels/:id/apply',
  ah(async (req, res) => {
    const id = uuid.parse(req.params.id);
    await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT location_id FROM location_label_assignments WHERE label_id = $1`,
        [id]
      );
      for (const r of rows) await applyLocationLabel(client, r.location_id, id);
    });
    res.json({ locations: await fetchLocationsByLabel(id) });
  })
);

labelsRouter.post(
  '/locations/:id/labels',
  ah(async (req, res) => {
    const locationId = uuid.parse(req.params.id);
    const b = labelAssign.parse(req.body);
    const locMap = await mapIdOf('locations', locationId);
    if ((await mapIdOf('location_labels', b.labelId)) !== locMap) {
      throw badRequest('the label belongs to a different map');
    }
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO location_label_assignments (location_id, label_id, applied_at)
         VALUES ($1,$2, now())
         ON CONFLICT (location_id, label_id) DO UPDATE SET applied_at = now()`,
        [locationId, b.labelId]
      );
      if (b.applyStyling ?? true) await applyLocationLabel(client, locationId, b.labelId);
    });
    res.json(await fetchLocation(locationId));
  })
);

/** Re-assert this label's defaults on a location it's already applied to. */
labelsRouter.post(
  '/locations/:id/labels/:labelId/apply',
  ah(async (req, res) => {
    const locationId = uuid.parse(req.params.id);
    const labelId = uuid.parse(req.params.labelId);
    if ((await mapIdOf('locations', locationId)) !== (await mapIdOf('location_labels', labelId))) {
      throw badRequest('the label belongs to a different map');
    }
    await withTransaction(async (client) => {
      await applyLocationLabel(client, locationId, labelId);
      await client.query(
        `UPDATE location_label_assignments SET applied_at = now()
          WHERE location_id = $1 AND label_id = $2`,
        [locationId, labelId]
      );
    });
    res.json(await fetchLocation(locationId));
  })
);

labelsRouter.delete(
  '/locations/:id/labels/:labelId',
  ah(async (req, res) => {
    const locationId = uuid.parse(req.params.id);
    await query(`DELETE FROM location_label_assignments WHERE location_id = $1 AND label_id = $2`, [
      locationId,
      uuid.parse(req.params.labelId)
    ]);
    res.json(await fetchLocation(locationId));
  })
);

/* ========================================================== connection labels */
labelsRouter.post(
  '/maps/:mapId/connection-labels',
  ah(async (req, res) => {
    const mapId = uuid.parse(req.params.mapId);
    const b = connectionLabelCreate.parse(req.body);
    /* default unlock conditions must point at rooms on this map */
    await assertLocationsOnMap(mapId, b.defaultRequires ?? []);
    const created = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO connection_labels
           (map_id, name, color, notes, default_color, default_text_color, default_travel_kind,
            default_direction, default_weight, default_ephemeral, default_locked, default_lock_note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [
          mapId,
          b.name ?? 'New Label',
          b.color ?? '',
          b.notes ?? '',
          b.defaultColor ?? '',
          b.defaultTextColor ?? '',
          b.defaultTravelKind ?? '',
          b.defaultDirection ?? '',
          b.defaultWeight ?? null,
          b.defaultEphemeral ?? null,
          b.defaultLocked ?? null,
          b.defaultLockNote ?? ''
        ]
      );
      const id = rows[0].id as string;
      for (const locId of b.defaultRequires ?? []) {
        await client.query(
          `INSERT INTO connection_label_requirements (label_id, location_id)
           VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [id, locId]
        );
      }
      return id;
    });
    res.status(201).json(await fetchConnectionLabel(created));
  })
);

labelsRouter.patch(
  '/connection-labels/:id',
  ah(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const b = connectionLabelUpdate.parse(req.body);
    const mapId = await mapIdOf('connection_labels', id);
    if (b.defaultRequires) await assertLocationsOnMap(mapId, b.defaultRequires);

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE connection_labels SET
            name                = COALESCE($2::text, name),
            color               = COALESCE($3::text, color),
            notes               = COALESCE($4::text, notes),
            default_color       = COALESCE($5::text, default_color),
            default_text_color  = COALESCE($6::text, default_text_color),
            default_travel_kind = COALESCE($7::text, default_travel_kind),
            default_direction   = COALESCE($8::text, default_direction),
            default_weight      = CASE WHEN $10::boolean THEN NULL
                                       ELSE COALESCE($9::float8, default_weight) END,
            default_ephemeral   = CASE WHEN $12::boolean THEN NULL
                                       ELSE COALESCE($11::boolean, default_ephemeral) END,
            default_locked      = CASE WHEN $14::boolean THEN NULL
                                       ELSE COALESCE($13::boolean, default_locked) END,
            default_lock_note   = COALESCE($15::text, default_lock_note)
          WHERE id = $1`,
        [
          id,
          b.name ?? null,
          b.color ?? null,
          b.notes ?? null,
          b.defaultColor ?? null,
          b.defaultTextColor ?? null,
          b.defaultTravelKind ?? null,
          b.defaultDirection ?? null,
          b.defaultWeight ?? null,
          Object.prototype.hasOwnProperty.call(req.body ?? {}, 'defaultWeight') &&
            b.defaultWeight === null,
          b.defaultEphemeral ?? null,
          Object.prototype.hasOwnProperty.call(req.body ?? {}, 'defaultEphemeral') &&
            b.defaultEphemeral === null,
          b.defaultLocked ?? null,
          Object.prototype.hasOwnProperty.call(req.body ?? {}, 'defaultLocked') &&
            b.defaultLocked === null,
          b.defaultLockNote ?? null
        ]
      );

      if (b.defaultRequires) {
        await client.query(`DELETE FROM connection_label_requirements WHERE label_id = $1`, [id]);
        for (const locId of b.defaultRequires) {
          await client.query(
            `INSERT INTO connection_label_requirements (label_id, location_id)
             VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [id, locId]
          );
        }
      }
    });

    res.json(await fetchConnectionLabel(id));
  })
);

labelsRouter.delete(
  '/connection-labels/:id',
  ah(async (req, res) => {
    const { rowCount } = await query(`DELETE FROM connection_labels WHERE id = $1`, [
      uuid.parse(req.params.id)
    ]);
    if (!rowCount) throw notFound('connection label');
    res.status(204).end();
  })
);

/** Re-stamp the label's current defaults onto every connection that carries it. */
labelsRouter.post(
  '/connection-labels/:id/apply',
  ah(async (req, res) => {
    const id = uuid.parse(req.params.id);
    await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT connection_id FROM connection_label_assignments WHERE label_id = $1`,
        [id]
      );
      for (const r of rows) await applyConnectionLabel(client, r.connection_id, id);
    });
    res.json({ connections: await fetchConnectionsByLabel(id) });
  })
);

labelsRouter.post(
  '/connections/:id/labels',
  ah(async (req, res) => {
    const connectionId = uuid.parse(req.params.id);
    const b = labelAssign.parse(req.body);
    const connMap = await mapIdOf('connections', connectionId);
    if ((await mapIdOf('connection_labels', b.labelId)) !== connMap) {
      throw badRequest('the label belongs to a different map');
    }
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO connection_label_assignments (connection_id, label_id, applied_at)
         VALUES ($1,$2, now())
         ON CONFLICT (connection_id, label_id) DO UPDATE SET applied_at = now()`,
        [connectionId, b.labelId]
      );
      if (b.applyStyling ?? true) await applyConnectionLabel(client, connectionId, b.labelId);
    });
    res.json(await fetchConnection(connectionId));
  })
);

labelsRouter.post(
  '/connections/:id/labels/:labelId/apply',
  ah(async (req, res) => {
    const connectionId = uuid.parse(req.params.id);
    const labelId = uuid.parse(req.params.labelId);
    if ((await mapIdOf('connections', connectionId)) !== (await mapIdOf('connection_labels', labelId))) {
      throw badRequest('the label belongs to a different map');
    }
    await withTransaction(async (client) => {
      await applyConnectionLabel(client, connectionId, labelId);
      await client.query(
        `UPDATE connection_label_assignments SET applied_at = now()
          WHERE connection_id = $1 AND label_id = $2`,
        [connectionId, labelId]
      );
    });
    res.json(await fetchConnection(connectionId));
  })
);

labelsRouter.delete(
  '/connections/:id/labels/:labelId',
  ah(async (req, res) => {
    const connectionId = uuid.parse(req.params.id);
    await query(
      `DELETE FROM connection_label_assignments WHERE connection_id = $1 AND label_id = $2`,
      [connectionId, uuid.parse(req.params.labelId)]
    );
    res.json(await fetchConnection(connectionId));
  })
);
