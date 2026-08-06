import { Router } from 'express';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db';
import { ah, badRequest, notFound } from '../http';
import { applyConnectionLabel, applyLocationLabel } from '../labelStyling';
import { mapLocationLabel } from '../mappers';
import {
  assertGroupOnMap,
  assertLocationsOnMap,
  fetchConnection,
  fetchConnectionLabel,
  fetchConnectionsByLabel,
  fetchLocation,
  fetchLocationLabel,
  fetchLocationsByLabel,
  mapIdOf,
  replaceRequirements,
  type MapOwnedTable
} from '../repo';
import { insertSql, updateSql } from '../sql';
import {
  connectionLabelCreate,
  connectionLabelUpdate,
  labelAssign,
  locationLabelCreate,
  locationLabelUpdate,
  uuid
} from '../validation';

export const labelsRouter = Router();

/* ======================================================= shared assignments
   Location and connection labels differ only in the tables they touch and the
   stamping function they call, so the assign / apply / unassign endpoints are
   generated from one description. All identifiers come from this file. */

interface LabelKind<T> {
  entityPath: 'locations' | 'connections';
  entityTable: MapOwnedTable;
  labelPath: 'location-labels' | 'connection-labels';
  labelTable: MapOwnedTable;
  assignTable: string;
  fk: 'location_id' | 'connection_id';
  noun: string;
  resultKey: 'locations' | 'connections';
  apply: (client: PoolClient, entityId: string, labelId: string) => Promise<void>;
  fetchOne: (id: string) => Promise<T>;
  fetchByLabel: (labelId: string) => Promise<T[]>;
}

function registerLabelRoutes<T>(k: LabelKind<T>) {
  const assertSameMap = async (entityId: string, labelId: string) => {
    const [a, b] = await Promise.all([
      mapIdOf(k.entityTable, entityId),
      mapIdOf(k.labelTable, labelId)
    ]);
    if (a !== b) throw badRequest('the label belongs to a different map');
  };

  labelsRouter.delete(
    `/${k.labelPath}/:id`,
    ah(async (req, res) => {
      const { rowCount } = await query(`DELETE FROM ${k.labelTable} WHERE id = $1`, [
        uuid.parse(req.params.id)
      ]);
      if (!rowCount) throw notFound(k.noun);
      res.status(204).end();
    })
  );

  /** Re-stamp the label's current defaults onto everything that carries it. */
  labelsRouter.post(
    `/${k.labelPath}/:id/apply`,
    ah(async (req, res) => {
      const id = uuid.parse(req.params.id);
      await withTransaction(async (client) => {
        const { rows } = await client.query(
          `SELECT ${k.fk} AS entity_id FROM ${k.assignTable} WHERE label_id = $1`,
          [id]
        );
        for (const r of rows) await k.apply(client, r.entity_id, id);
      });
      res.json({ [k.resultKey]: await k.fetchByLabel(id) });
    })
  );

  labelsRouter.post(
    `/${k.entityPath}/:id/labels`,
    ah(async (req, res) => {
      const entityId = uuid.parse(req.params.id);
      const b = labelAssign.parse(req.body);
      await assertSameMap(entityId, b.labelId);

      await withTransaction(async (client) => {
        await client.query(
          `INSERT INTO ${k.assignTable} (${k.fk}, label_id, applied_at)
           VALUES ($1,$2, now())
           ON CONFLICT (${k.fk}, label_id) DO UPDATE SET applied_at = now()`,
          [entityId, b.labelId]
        );
        if (b.applyStyling ?? true) await k.apply(client, entityId, b.labelId);
      });

      res.json(await k.fetchOne(entityId));
    })
  );

  /** Re-assert this label's defaults on something it is already applied to. */
  labelsRouter.post(
    `/${k.entityPath}/:id/labels/:labelId/apply`,
    ah(async (req, res) => {
      const entityId = uuid.parse(req.params.id);
      const labelId = uuid.parse(req.params.labelId);
      await assertSameMap(entityId, labelId);

      await withTransaction(async (client) => {
        await k.apply(client, entityId, labelId);
        await client.query(
          `UPDATE ${k.assignTable} SET applied_at = now() WHERE ${k.fk} = $1 AND label_id = $2`,
          [entityId, labelId]
        );
      });

      res.json(await k.fetchOne(entityId));
    })
  );

  labelsRouter.delete(
    `/${k.entityPath}/:id/labels/:labelId`,
    ah(async (req, res) => {
      const entityId = uuid.parse(req.params.id);
      await query(`DELETE FROM ${k.assignTable} WHERE ${k.fk} = $1 AND label_id = $2`, [
        entityId,
        uuid.parse(req.params.labelId)
      ]);
      res.json(await k.fetchOne(entityId));
    })
  );
}

registerLabelRoutes({
  entityPath: 'locations',
  entityTable: 'locations',
  labelPath: 'location-labels',
  labelTable: 'location_labels',
  assignTable: 'location_label_assignments',
  fk: 'location_id',
  noun: 'location label',
  resultKey: 'locations',
  apply: applyLocationLabel,
  fetchOne: fetchLocation,
  fetchByLabel: fetchLocationsByLabel
});

registerLabelRoutes({
  entityPath: 'connections',
  entityTable: 'connections',
  labelPath: 'connection-labels',
  labelTable: 'connection_labels',
  assignTable: 'connection_label_assignments',
  fk: 'connection_id',
  noun: 'connection label',
  resultKey: 'connections',
  apply: applyConnectionLabel,
  fetchOne: fetchConnection,
  fetchByLabel: fetchConnectionsByLabel
});

/* ============================================================ location labels */

const locationLabelColumns = (b: ReturnType<typeof locationLabelCreate.parse>) => ({
  name: b.name,
  color: b.color,
  notes: b.notes,
  default_kind: b.defaultKind,
  default_size: b.defaultSize,
  default_color: b.defaultColor,
  default_text_color: b.defaultTextColor,
  default_group_id: b.defaultGroupId
});

labelsRouter.post(
  '/maps/:mapId/location-labels',
  ah(async (req, res) => {
    const mapId = uuid.parse(req.params.mapId);
    const b = locationLabelCreate.parse(req.body);
    if (b.defaultGroupId) await assertGroupOnMap(b.defaultGroupId, mapId);

    const stmt = insertSql('location_labels', {
      map_id: mapId,
      ...locationLabelColumns(b),
      name: b.name ?? 'New Label'
    });
    const { rows } = await query(stmt.text, stmt.values);
    res.status(201).json(mapLocationLabel(rows[0]));
  })
);

labelsRouter.patch(
  '/location-labels/:id',
  ah(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const b = locationLabelUpdate.parse(req.body);
    const mapId = await mapIdOf('location_labels', id);
    if (b.defaultGroupId) await assertGroupOnMap(b.defaultGroupId, mapId);

    const stmt = updateSql('location_labels', id, locationLabelColumns(b));
    if (stmt) await query(stmt.text, stmt.values);
    res.json(await fetchLocationLabel(id));
  })
);

/* ========================================================== connection labels */

const connectionLabelColumns = (b: ReturnType<typeof connectionLabelCreate.parse>) => ({
  name: b.name,
  color: b.color,
  notes: b.notes,
  default_color: b.defaultColor,
  default_text_color: b.defaultTextColor,
  default_travel_kind: b.defaultTravelKind,
  default_direction: b.defaultDirection,
  default_weight: b.defaultWeight,
  default_ephemeral: b.defaultEphemeral,
  default_locked: b.defaultLocked,
  default_lock_note: b.defaultLockNote
});

labelsRouter.post(
  '/maps/:mapId/connection-labels',
  ah(async (req, res) => {
    const mapId = uuid.parse(req.params.mapId);
    const b = connectionLabelCreate.parse(req.body);
    /* default unlock conditions must point at rooms on this map */
    await assertLocationsOnMap(mapId, b.defaultRequires ?? []);

    const id = await withTransaction(async (client) => {
      const stmt = insertSql(
        'connection_labels',
        { map_id: mapId, ...connectionLabelColumns(b), name: b.name ?? 'New Label' },
        'id'
      );
      const { rows } = await client.query(stmt.text, stmt.values);
      const id = rows[0].id as string;
      if (b.defaultRequires?.length) {
        await replaceRequirements(client, 'label', id, b.defaultRequires);
      }
      return id;
    });

    res.status(201).json(await fetchConnectionLabel(id));
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
      const stmt = updateSql('connection_labels', id, connectionLabelColumns(b));
      if (stmt) await client.query(stmt.text, stmt.values);
      if (b.defaultRequires) await replaceRequirements(client, 'label', id, b.defaultRequires);
    });

    res.json(await fetchConnectionLabel(id));
  })
);
