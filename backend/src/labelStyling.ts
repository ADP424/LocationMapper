import type { PoolClient } from 'pg';
import { updateSql } from './sql';

/**
 * Stamp a label's defaults. Text columns use '' for "no override"; nullable
 * columns (uuid, boolean, float) use NULL — so in both cases the column is
 * simply omitted from the UPDATE.
 */
const text = (v: string) => (v ? v : undefined);
const nullable = <T>(v: T | null) => (v === null ? undefined : v);

export async function applyLocationLabel(client: PoolClient, locationId: string, labelId: string) {
  const { rows } = await client.query(`SELECT * FROM location_labels WHERE id = $1`, [labelId]);
  const l = rows[0];
  if (!l) return;

  const stmt = updateSql('locations', locationId, {
    kind: text(l.default_kind),
    size: nullable(l.default_size),
    color: text(l.default_color),
    text_color: text(l.default_text_color),
    layer: text(l.default_layer),
    group_id: nullable(l.default_group_id)
  });
  if (stmt) await client.query(stmt.text, stmt.values);
}

const ARROWS: Record<string, [boolean, boolean] | undefined> = {
  forward: [false, true],
  backward: [true, false],
  both: [true, true],
  none: [false, false]
};

/**
 * Stamp a connection label's defaults, including its opt-in unlock conditions
 * (which travel with the `locked` default).
 */
export async function applyConnectionLabel(
  client: PoolClient,
  connectionId: string,
  labelId: string
) {
  const { rows } = await client.query(`SELECT * FROM connection_labels WHERE id = $1`, [labelId]);
  const l = rows[0];
  if (!l) return;

  const arrows = ARROWS[l.default_direction as string];

  const stmt = updateSql('connections', connectionId, {
    color: text(l.default_color),
    text_color: text(l.default_text_color),
    travel_kind: text(l.default_travel_kind),
    arrow_source: arrows?.[0],
    arrow_target: arrows?.[1],
    weight: nullable(l.default_weight),
    ephemeral: nullable(l.default_ephemeral),
    locked: nullable(l.default_locked),
    lock_note: text(l.default_lock_note)
  });
  if (stmt) await client.query(stmt.text, stmt.values);

  const { rows: counted } = await client.query(
    `SELECT count(*)::int AS n FROM connection_label_requirements WHERE label_id = $1`,
    [labelId]
  );
  if (counted[0].n === 0 && l.default_locked === null) return;

  await client.query(`DELETE FROM connection_requirements WHERE connection_id = $1`, [connectionId]);
  /* copy in one statement, and only rooms that live on the connection's own
     map — the DB trigger is the backstop, this keeps it from ever firing */
  await client.query(
    `INSERT INTO connection_requirements (connection_id, location_id)
     SELECT c.id, l.id
       FROM connections c
       JOIN connection_label_requirements r ON r.label_id = $2
       JOIN locations l ON l.id = r.location_id AND l.map_id = c.map_id
      WHERE c.id = $1
     ON CONFLICT DO NOTHING`,
    [connectionId, labelId]
  );
}
