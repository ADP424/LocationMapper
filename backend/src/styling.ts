import type { PoolClient } from 'pg';
import { updateSql } from './sql';

/**
 * Two systems stamp a room's styling: its **labels** and its **grouping**. The
 * rule that arbitrates them lives here and nowhere else:
 *
 *   a stamp never writes a property the *other* system already claims,
 *   unless its own override flag says it may.
 *
 * Per property, not per entity — a grouping that sets shape and colour still
 * sets the shape of a room whose label only claims the colour. Label-over-label
 * is untouched by any of this: the last label applied wins, always.
 *
 * "Claims a property" falls out of the existing encoding for free: text columns
 * use '' for "no override" and nullable columns use NULL, so in both cases the
 * column is simply omitted from the UPDATE — and *claimed* is exactly *present
 * in this object*.
 */
const text = (v: string) => (v ? v : undefined);
const nullable = <T>(v: T | null) => (v === null ? undefined : v);

type Columns = Record<string, unknown>;

/** What a location label stamps onto a room. */
const labelColumns = (l: any): Columns => ({
  kind: text(l.default_kind),
  size: nullable(l.default_size),
  color: text(l.default_color),
  text_color: text(l.default_text_color),
  group_id: nullable(l.default_group_id)
});

/** What a grouping stamps onto its rooms. A grouping never sets `group_id`:
 *  membership is the thing that makes it apply in the first place. */
const groupColumns = (g: any): Columns => ({
  kind: text(g.default_kind),
  size: nullable(g.default_size),
  color: text(g.default_color),
  text_color: text(g.default_text_color)
});

const claimed = (cols: Columns) =>
  new Set(
    Object.entries(cols)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k)
  );

/** Drop every property somebody else owns. */
const yieldTo = (cols: Columns, theirs: Iterable<string>) => {
  for (const key of theirs) delete cols[key];
  return cols;
};

/**
 * Stamp a label's defaults onto a room.
 *
 * Only the room's *grouping* can hold a property back, and only while this
 * label has not been told it may override groupings. The grouping consulted is
 * the one the room is in right now — a label whose own default moves the room
 * into a different grouping does not inherit that grouping's styling, for the
 * same reason moving a room by hand does not.
 */
export async function applyLocationLabel(client: PoolClient, locationId: string, labelId: string) {
  const { rows } = await client.query(`SELECT * FROM location_labels WHERE id = $1`, [labelId]);
  const label = rows[0];
  if (!label) return;

  const cols = labelColumns(label);

  if (!label.override_groupings) {
    const { rows: groups } = await client.query(
      `SELECT g.* FROM locations l JOIN groups g ON g.id = l.group_id WHERE l.id = $1`,
      [locationId]
    );
    if (groups[0]) yieldTo(cols, claimed(groupColumns(groups[0])));
  }

  const stmt = updateSql('locations', locationId, cols);
  if (stmt) await client.query(stmt.text, stmt.values);
}

/**
 * Stamp a grouping's defaults onto one of its rooms.
 *
 * Called when a room is **created** inside the grouping, and on demand from
 * "Re-Apply Styling" — never when a room merely moves in, which is exactly the
 * contract labels already have. `skip` is for creation: columns the request set
 * by hand are never clobbered by a default.
 */
export async function applyGroupStyling(
  client: PoolClient,
  locationId: string,
  groupId: string,
  skip: Iterable<string> = []
) {
  const { rows } = await client.query(`SELECT * FROM groups WHERE id = $1`, [groupId]);
  const group = rows[0];
  if (!group) return;

  const cols = yieldTo(groupColumns(group), skip);

  if (!group.override_labels) {
    const { rows: labels } = await client.query(
      `SELECT ll.* FROM location_label_assignments a
         JOIN location_labels ll ON ll.id = a.label_id
        WHERE a.location_id = $1`,
      [locationId]
    );
    for (const label of labels) yieldTo(cols, claimed(labelColumns(label)));
  }

  const stmt = updateSql('locations', locationId, cols);
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
 * (which travel with the `locked` default). Connections have no grouping, so
 * there is nothing to negotiate with — this one is unchanged.
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
