import type { PoolClient } from 'pg';

/**
 * Stamp a location label's defaults onto a location.
 * Text columns: '' means "no override". uuid columns: NULL does.
 */
export async function applyLocationLabel(client: PoolClient, locationId: string, labelId: string) {
  const { rows } = await client.query(`SELECT * FROM location_labels WHERE id = $1`, [labelId]);
  if (!rows.length) return;
  const l = rows[0];

  await client.query(
    `UPDATE locations SET
        kind       = CASE WHEN $2::text <> '' THEN $2::text ELSE kind END,
        color      = CASE WHEN $3::text <> '' THEN $3::text ELSE color END,
        text_color = CASE WHEN $4::text <> '' THEN $4::text ELSE text_color END,
        layer      = CASE WHEN $5::text <> '' THEN $5::text ELSE layer END,
        group_id   = COALESCE($6::uuid, group_id)
      WHERE id = $1`,
    [locationId, l.default_kind, l.default_color, l.default_text_color, l.default_layer, l.default_group_id]
  );
}

const ARROWS: Record<string, [boolean, boolean] | null> = {
  forward: [false, true],
  backward: [true, false],
  both: [true, true],
  none: [false, false]
};

/**
 * Stamp a connection label's defaults onto a connection, including its
 * opt-in unlock conditions (which travel with the locked default).
 */
export async function applyConnectionLabel(
  client: PoolClient,
  connectionId: string,
  labelId: string
) {
  const { rows } = await client.query(`SELECT * FROM connection_labels WHERE id = $1`, [labelId]);
  if (!rows.length) return;
  const l = rows[0];
  const arrows = ARROWS[l.default_direction as string] ?? null;

  await client.query(
    `UPDATE connections SET
        color        = CASE WHEN $2::text <> '' THEN $2::text ELSE color END,
        text_color   = CASE WHEN $3::text <> '' THEN $3::text ELSE text_color END,
        travel_kind  = CASE WHEN $4::text <> '' THEN $4::text ELSE travel_kind END,
        arrow_source = COALESCE($5::boolean, arrow_source),
        arrow_target = COALESCE($6::boolean, arrow_target),
        weight       = COALESCE($7::float8, weight),
        ephemeral    = COALESCE($8::boolean, ephemeral),
        locked       = COALESCE($9::boolean, locked),
        lock_note    = CASE WHEN $10::text <> '' THEN $10::text ELSE lock_note END
      WHERE id = $1`,
    [
      connectionId,
      l.default_color,
      l.default_text_color,
      l.default_travel_kind,
      arrows ? arrows[0] : null,
      arrows ? arrows[1] : null,
      l.default_weight,
      l.default_ephemeral,
      l.default_locked,
      l.default_lock_note
    ]
  );

  const reqCount = await client.query(
    `SELECT count(*)::int AS n FROM connection_label_requirements WHERE label_id = $1`,
    [labelId]
  );
  if (reqCount.rows[0].n > 0 || l.default_locked !== null) {
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
}
