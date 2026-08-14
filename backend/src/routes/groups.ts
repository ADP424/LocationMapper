import { Router } from 'express';
import { query, withTransaction } from '../db';
import { ah, badRequest, notFound } from '../http';
import { mapGroup } from '../mappers';
import {
  assertGroupOnMap,
  assertLocationsOnMap,
  assertMapExists,
  fetchLocation,
  fetchLocationsByGroup,
  mapIdOf
} from '../repo';
import { insertSql, updateSql } from '../sql';
import { applyGroupStyling } from '../styling';
import { groupAssign, groupCreate, groupUpdate, uuid } from '../validation';

export const groupsRouter = Router();

/** Request body -> column names. */
const columns = (b: ReturnType<typeof groupUpdate.parse>) => ({
  name: b.name,
  color: b.color,
  text_color: b.textColor,
  notes: b.notes,
  display_style: b.displayStyle,
  body_padding: b.bodyPadding,
  parent_id: b.parentId,
  default_kind: b.defaultKind,
  default_size: b.defaultSize,
  default_color: b.defaultColor,
  default_text_color: b.defaultTextColor,
  override_labels: b.overrideLabels
});

/** Reject `child -> … -> parent -> child` loops before they can be written. */
async function assertNoCycle(groupId: string, parentId: string) {
  if (groupId === parentId) throw badRequest('a grouping cannot be its own parent');
  const { rows } = await query(
    `WITH RECURSIVE ancestors AS (
        SELECT id, parent_id FROM groups WHERE id = $1
        UNION ALL
        SELECT g.id, g.parent_id FROM groups g JOIN ancestors a ON g.id = a.parent_id
     )
     SELECT 1 FROM ancestors WHERE id = $2 LIMIT 1`,
    [parentId, groupId]
  );
  if (rows.length) throw badRequest('that would create a circular grouping');
}

groupsRouter.post(
  '/maps/:mapId/groups',
  ah(async (req, res) => {
    const mapId = uuid.parse(req.params.mapId);
    const b = groupCreate.parse(req.body);

    await assertMapExists(mapId);
    if (b.parentId) await assertGroupOnMap(b.parentId, mapId);
    if (b.locationIds?.length) await assertLocationsOnMap(mapId, b.locationIds);

    const group = await withTransaction(async (client) => {
      const stmt = insertSql('groups', {
        map_id: mapId,
        ...columns(b),
        name: b.name ?? 'New Grouping'
      });
      const { rows } = await client.query(stmt.text, stmt.values);
      if (b.locationIds?.length) {
        await client.query(
          `INSERT INTO location_group_assignments (location_id, group_id)
             SELECT id, $1 FROM locations WHERE map_id = $2 AND id = ANY($3::uuid[])
           ON CONFLICT DO NOTHING`,
          [rows[0].id, mapId, b.locationIds]
        );
      }
      return rows[0];
    });

    res.status(201).json(mapGroup(group));
  })
);

groupsRouter.get(
  '/groups/:id',
  ah(async (req, res) => {
    const { rows } = await query(`SELECT * FROM groups WHERE id = $1`, [uuid.parse(req.params.id)]);
    if (!rows.length) throw notFound('group');
    res.json(mapGroup(rows[0]));
  })
);

groupsRouter.patch(
  '/groups/:id',
  ah(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const b = groupUpdate.parse(req.body);
    const mapId = await mapIdOf('groups', id);

    if (b.parentId) {
      await assertGroupOnMap(b.parentId, mapId);
      await assertNoCycle(id, b.parentId);
    }

    const stmt = updateSql('groups', id, columns(b), '*');
    const { rows } = stmt
      ? await query(stmt.text, stmt.values)
      : await query(`SELECT * FROM groups WHERE id = $1`, [id]);
    res.json(mapGroup(rows[0]));
  })
);

/** Rooms and sub-groupings survive; they simply move up a level. */
groupsRouter.delete(
  '/groups/:id',
  ah(async (req, res) => {
    const { rowCount } = await query(`DELETE FROM groups WHERE id = $1`, [
      uuid.parse(req.params.id)
    ]);
    if (!rowCount) throw notFound('group');
    res.status(204).end();
  })
);

groupsRouter.post(
  '/groups/:id/ungroup',
  ah(async (req, res) => {
    const { rowCount } = await query(
      `DELETE FROM location_group_assignments WHERE group_id = $1`,
      [uuid.parse(req.params.id)]
    );
    res.json({ released: rowCount ?? 0 });
  })
);

/** Re-stamp this grouping's defaults onto every room inside it. */
groupsRouter.post(
  '/groups/:id/apply',
  ah(async (req, res) => {
    const id = uuid.parse(req.params.id);
    await mapIdOf('groups', id); // 404s for an unknown grouping
    await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT location_id AS id FROM location_group_assignments WHERE group_id = $1`,
        [id]
      );
      for (const r of rows) await applyGroupStyling(client, r.id, id);
    });
    res.json({ locations: await fetchLocationsByGroup(id) });
  })
);

/** Join a grouping. Stamps its defaults immediately, exactly as applying a
 *  label does — memberships are additive, so joining is the deliberate act. */
groupsRouter.post(
  '/locations/:locationId/groups',
  ah(async (req, res) => {
    const locationId = uuid.parse(req.params.locationId);
    const b = groupAssign.parse(req.body);
    const mapId = await mapIdOf('locations', locationId);
    await assertGroupOnMap(b.groupId, mapId);
    await withTransaction(async (client) => {
      /* re-joining a grouping already held bumps it to newest, matching the
         label semantics a later assignment overwrites an earlier stamp with —
         and is what makes "the newest membership wins" a coherent rule at all */
      await client.query(
        `INSERT INTO location_group_assignments (location_id, group_id) VALUES ($1, $2)
         ON CONFLICT (location_id, group_id)
           DO UPDATE SET added_at = now(), seq = nextval('location_group_assignments_seq')`,
        [locationId, b.groupId]
      );
      if (b.applyStyling !== false) await applyGroupStyling(client, locationId, b.groupId);
    });
    res.json(await fetchLocation(locationId));
  })
);

groupsRouter.delete(
  '/locations/:locationId/groups/:groupId',
  ah(async (req, res) => {
    const locationId = uuid.parse(req.params.locationId);
    await query(
      `DELETE FROM location_group_assignments WHERE location_id = $1 AND group_id = $2`,
      [locationId, uuid.parse(req.params.groupId)]
    );
    res.json(await fetchLocation(locationId));
  })
);

/** Stamp one grouping's defaults onto one of its rooms, on demand. */
groupsRouter.post(
  '/locations/:locationId/groups/:groupId/apply',
  ah(async (req, res) => {
    const locationId = uuid.parse(req.params.locationId);
    const groupId = uuid.parse(req.params.groupId);
    await fetchLocation(locationId); // 404s if it is gone
    await withTransaction((client) => applyGroupStyling(client, locationId, groupId));
    res.json(await fetchLocation(locationId));
  })
);
