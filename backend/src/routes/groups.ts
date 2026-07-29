import { Router } from 'express';
import { query, withTransaction } from '../db';
import { ah, badRequest, notFound } from '../http';
import { mapGroup } from '../mappers';
import { groupCreate, groupUpdate, uuid } from '../validation';

export const groupsRouter = Router();

async function groupMap(id: string): Promise<string> {
  const { rows } = await query(`SELECT map_id FROM groups WHERE id = $1`, [id]);
  if (!rows.length) throw notFound('group');
  return rows[0].map_id as string;
}

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

    const exists = await query(`SELECT 1 FROM maps WHERE id = $1`, [mapId]);
    if (!exists.rowCount) throw notFound('map');

    if (b.parentId && (await groupMap(b.parentId)) !== mapId) {
      throw badRequest('the parent grouping belongs to a different map');
    }

    if (b.locationIds?.length) {
      const unique = [...new Set(b.locationIds)];
      const { rows } = await query(
        `SELECT count(*)::int AS n FROM locations WHERE map_id = $1 AND id = ANY($2::uuid[])`,
        [mapId, unique]
      );
      if (rows[0].n !== unique.length) {
        throw badRequest('all member locations must belong to the same map');
      }
    }

    const group = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO groups (map_id, parent_id, name, color, text_color, notes)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [
          mapId,
          b.parentId ?? null,
          b.name ?? 'New Grouping',
          b.color ?? '',
          b.textColor ?? '',
          b.notes ?? ''
        ]
      );
      const created = rows[0];
      if (b.locationIds?.length) {
        await client.query(
          `UPDATE locations SET group_id = $1 WHERE map_id = $2 AND id = ANY($3::uuid[])`,
          [created.id, mapId, b.locationIds]
        );
      }
      return created;
    });

    res.status(201).json(mapGroup(group));
  })
);

groupsRouter.get(
  '/groups/:id',
  ah(async (req, res) => {
    const { rows } = await query(`SELECT * FROM groups WHERE id = $1`, [
      uuid.parse(req.params.id)
    ]);
    if (!rows.length) throw notFound('group');
    res.json(mapGroup(rows[0]));
  })
);

groupsRouter.patch(
  '/groups/:id',
  ah(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const b = groupUpdate.parse(req.body);
    const mapId = await groupMap(id);

    if (b.parentId) {
      if ((await groupMap(b.parentId)) !== mapId) {
        throw badRequest('the parent grouping belongs to a different map');
      }
      await assertNoCycle(id, b.parentId);
    }
    const clearParent =
      Object.prototype.hasOwnProperty.call(req.body ?? {}, 'parentId') && b.parentId === null;

    const { rows } = await query(
      `UPDATE groups SET
          name      = COALESCE($2::text, name),
          color     = COALESCE($3::text, color),
          text_color = COALESCE($4::text, text_color),
          notes     = COALESCE($5::text, notes),
          parent_id = CASE WHEN $7::boolean THEN NULL
                           ELSE COALESCE($6::uuid, parent_id) END
        WHERE id = $1
        RETURNING *`,
      [
        id,
        b.name ?? null,
        b.color ?? null,
        b.textColor ?? null,
        b.notes ?? null,
        b.parentId ?? null,
        clearParent
      ]
    );
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
    const id = uuid.parse(req.params.id);
    const { rowCount } = await query(`UPDATE locations SET group_id = NULL WHERE group_id = $1`, [
      id
    ]);
    res.json({ released: rowCount ?? 0 });
  })
);
