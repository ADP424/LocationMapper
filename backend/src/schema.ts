import { query } from './db';

/**
 * The entire database schema, in one place. Re-running it is a no-op, so the
 * backend simply applies it on every boot. There is no migration system and no
 * upgrade path: this file *is* the schema.
 *
 *   maps ─┬─ groups ──────────── parent_id -> groups (nestable, cycle-checked)
 *         ├─ connection_labels ─ connection_label_requirements -> locations
 *         ├─ location_labels ─── location_label_restarts -> locations (one-way
 *         │                        "restart" moves, never drawn, planner-only)
 *         ├─ locations ────────┬ location_group_assignments -> groups (many-to-many;
 *         │                    │   oldest assignment per room is the layout anchor)
 *         │                    └ location_label_assignments -> location_labels
 *         ├─ connections ──────┬ source_id / target_id -> locations
 *         │                    ├ connection_requirements -> locations
 *         │                    └ connection_label_assignments -> connection_labels
 *         └─ start_location_id -> locations (where a new trip begins; SET NULL)
 */
export const SCHEMA_SQL = /* sql */ `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS maps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text        NOT NULL,
  description  text        NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- A visual grouping ("House", "Floor 3", "Old Town") drawn behind its member
-- locations. display_style chooses the body: a translucent rounded rectangle
-- over the whole extent, a rectilinear outline form-fitted to the members, or
-- a closed orthogonal band threaded through them. Groupings nest; cycles are
-- rejected by the API and self-parenting by a trigger.
CREATE TABLE IF NOT EXISTS groups (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  map_id       uuid        NOT NULL REFERENCES maps(id)   ON DELETE CASCADE,
  parent_id    uuid                 REFERENCES groups(id) ON DELETE SET NULL,
  name         text        NOT NULL DEFAULT '',
  color        text        NOT NULL DEFAULT '',
  text_color   text        NOT NULL DEFAULT '',   -- '' = follow the body colour
  notes        text        NOT NULL DEFAULT '',
  display_style text       NOT NULL DEFAULT 'rectangle'
    CONSTRAINT groups_display_style_valid
      CHECK (display_style IN ('rectangle', 'outline', 'loop')),
  -- how far the drawn body extends past its rooms; also the thickness of the
  -- outline's corridors and of the snake's band. NULL = the app default.
  body_padding double precision
    CONSTRAINT groups_body_padding_sane
      CHECK (body_padding IS NULL OR (body_padding >= 0 AND body_padding <= 400)),
  -- label-style defaults, stamped onto rooms created inside this grouping
  default_kind       text NOT NULL DEFAULT '',
  default_size       double precision
    CONSTRAINT groups_default_size_positive CHECK (default_size IS NULL OR default_size > 0),
  default_color      text NOT NULL DEFAULT '',
  default_text_color text NOT NULL DEFAULT '',
  -- stamp over properties the room's labels already claim
  override_labels    boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS locations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  map_id       uuid        NOT NULL REFERENCES maps(id)   ON DELETE CASCADE,
  name         text        NOT NULL DEFAULT '',
  kind         text        NOT NULL DEFAULT 'round-rectangle',
  -- scalar on the drawn box: 2 = twice as wide and tall as a default room
  size         double precision NOT NULL DEFAULT 1 CHECK (size > 0),
  notes        text        NOT NULL DEFAULT '',
  color        text        NOT NULL DEFAULT '',
  text_color   text        NOT NULL DEFAULT '',
  visited      boolean     NOT NULL DEFAULT false,
  x            double precision,
  y            double precision,
  -- optional integer coordinates; any axis may be NULL ("no coordinate")
  coord_x      integer,
  coord_y      integer,
  coord_z      integer,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- A room belongs to any number of groupings. added_at (plus seq, a tie-break
-- for rows inserted in the same statement/transaction, which share one
-- timestamp) orders them: the oldest is the layout anchor, i.e. the compound
-- parent every other membership merely draws a body around. Mirrors
-- location_label_assignments, with seq added because assignment order here is
-- load-bearing (it decides containment) in a way label order never was.
CREATE SEQUENCE IF NOT EXISTS location_group_assignments_seq;
CREATE TABLE IF NOT EXISTS location_group_assignments (
  location_id uuid        NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  group_id    uuid        NOT NULL REFERENCES groups(id)    ON DELETE CASCADE,
  added_at    timestamptz NOT NULL DEFAULT now(),
  seq         bigint      NOT NULL DEFAULT nextval('location_group_assignments_seq'),
  PRIMARY KEY (location_id, group_id)
);

CREATE TABLE IF NOT EXISTS connections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  map_id        uuid        NOT NULL REFERENCES maps(id)      ON DELETE CASCADE,
  source_id     uuid        NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  target_id     uuid        NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name          text        NOT NULL DEFAULT '',
  notes         text        NOT NULL DEFAULT '',
  travel_kind   text        NOT NULL DEFAULT 'default',   -- default | solid | dashed | dotted
  color         text        NOT NULL DEFAULT '',
  text_color    text        NOT NULL DEFAULT '',
  arrow_source  boolean     NOT NULL DEFAULT false,
  arrow_target  boolean     NOT NULL DEFAULT true,
  ephemeral     boolean     NOT NULL DEFAULT false,
  locked        boolean     NOT NULL DEFAULT false,
  lock_note     text        NOT NULL DEFAULT '',
  weight        double precision NOT NULL DEFAULT 1 CHECK (weight > 0),
  -- ephemeral stub boxes, stored as an offset from their anchor room
  out_dx        double precision,
  out_dy        double precision,
  in_dx         double precision,
  in_dy         double precision,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS connection_requirements (
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  location_id   uuid NOT NULL REFERENCES locations(id)   ON DELETE CASCADE,
  PRIMARY KEY (connection_id, location_id)
);

-- ============================================================================
--  Labels: reusable categories that can stamp opt-in default properties onto
--  the locations / connections they are applied to. Every default_* column
--  that is '' (or NULL) means "no override" -- applying the label leaves that
--  property untouched. Assigning a label stamps its defaults immediately;
--  since a later assignment can overwrite an earlier one's stamp, applied_at
--  records which was last.
-- ============================================================================
CREATE TABLE IF NOT EXISTS location_labels (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  map_id              uuid        NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  name                text        NOT NULL DEFAULT '',
  color               text        NOT NULL DEFAULT '',   -- the chip colour
  notes               text        NOT NULL DEFAULT '',
  default_kind        text        NOT NULL DEFAULT '',   -- shape key
  default_size        double precision CHECK (default_size IS NULL OR default_size > 0),
  default_color       text        NOT NULL DEFAULT '',   -- box fill
  default_text_color  text        NOT NULL DEFAULT '',
  -- stamp over properties the room's groupings already claim
  override_groupings  boolean     NOT NULL DEFAULT false,
  -- "restart": a one-way move every labelled room gains, to each row in
  -- location_label_restarts. Never drawn; the trip planner may decline to use it.
  restart_name        text        NOT NULL DEFAULT '',   -- '' renders as "Restart"
  restart_weight      double precision NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS location_label_assignments (
  location_id uuid        NOT NULL REFERENCES locations(id)       ON DELETE CASCADE,
  label_id    uuid        NOT NULL REFERENCES location_labels(id) ON DELETE CASCADE,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, label_id)
);

-- Where a room carrying the label may "restart" to. One-way, from every labelled
-- room to every target. Deleting a location removes it from every label's list.
CREATE TABLE IF NOT EXISTS location_label_restarts (
  label_id    uuid NOT NULL REFERENCES location_labels(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES locations(id)       ON DELETE CASCADE,
  PRIMARY KEY (label_id, location_id)
);

CREATE TABLE IF NOT EXISTS connection_labels (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  map_id              uuid        NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  name                text        NOT NULL DEFAULT '',
  color               text        NOT NULL DEFAULT '',
  notes               text        NOT NULL DEFAULT '',
  default_color       text        NOT NULL DEFAULT '',   -- line colour
  default_text_color  text        NOT NULL DEFAULT '',
  default_travel_kind text        NOT NULL DEFAULT '',   -- '' | default | solid | dashed | dotted
  default_direction   text        NOT NULL DEFAULT '',   -- '' | forward | backward | both | none
  default_weight      double precision CHECK (default_weight IS NULL OR default_weight > 0),
  default_ephemeral   boolean,                           -- NULL => no override
  default_locked      boolean,                           -- NULL => no override
  default_lock_note   text        NOT NULL DEFAULT '',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- default unlock conditions carried by a connection label
CREATE TABLE IF NOT EXISTS connection_label_requirements (
  label_id    uuid NOT NULL REFERENCES connection_labels(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES locations(id)         ON DELETE CASCADE,
  PRIMARY KEY (label_id, location_id)
);

CREATE TABLE IF NOT EXISTS connection_label_assignments (
  connection_id uuid        NOT NULL REFERENCES connections(id)       ON DELETE CASCADE,
  label_id      uuid        NOT NULL REFERENCES connection_labels(id) ON DELETE CASCADE,
  applied_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, label_id)
);

-- The free-form "layer" text field is gone: coordinates and groupings cover
-- what it did. DROP COLUMN IF EXISTS is idempotent, so an existing database
-- converges on next boot with no separate migration step.
ALTER TABLE locations       DROP COLUMN IF EXISTS layer;
ALTER TABLE location_labels DROP COLUMN IF EXISTS default_layer;

-- Groupings grew label-style defaults, and both systems grew the flag that
-- decides which of the two wins. ADD COLUMN IF NOT EXISTS is idempotent, so an
-- existing database converges on next boot with no separate migration step.
ALTER TABLE groups          ADD COLUMN IF NOT EXISTS default_kind       text NOT NULL DEFAULT '';
ALTER TABLE groups          ADD COLUMN IF NOT EXISTS default_size       double precision;
ALTER TABLE groups          ADD COLUMN IF NOT EXISTS default_color      text NOT NULL DEFAULT '';
ALTER TABLE groups          ADD COLUMN IF NOT EXISTS default_text_color text NOT NULL DEFAULT '';
ALTER TABLE groups          ADD COLUMN IF NOT EXISTS override_labels    boolean NOT NULL DEFAULT false;
ALTER TABLE groups          ADD COLUMN IF NOT EXISTS display_style      text NOT NULL DEFAULT 'rectangle';
ALTER TABLE groups          ADD COLUMN IF NOT EXISTS body_padding       double precision;
-- relax the earlier NOT NULL DEFAULT 30 variant of this column; both statements
-- are idempotent (a no-op once the column is already nullable with no default)
ALTER TABLE groups          ALTER COLUMN body_padding DROP NOT NULL;
ALTER TABLE groups          ALTER COLUMN body_padding DROP DEFAULT;
ALTER TABLE location_labels ADD COLUMN IF NOT EXISTS override_groupings boolean NOT NULL DEFAULT false;
ALTER TABLE location_labels ADD COLUMN IF NOT EXISTS restart_name       text NOT NULL DEFAULT '';
ALTER TABLE location_labels ADD COLUMN IF NOT EXISTS restart_weight     double precision NOT NULL DEFAULT 1;

DO $mig$ BEGIN
  ALTER TABLE location_labels
    ADD CONSTRAINT location_labels_restart_weight_sane
      CHECK (restart_weight >= 0 AND restart_weight <= 10000);
EXCEPTION WHEN duplicate_object THEN NULL;
END $mig$;

-- A map's default trip start. The column can only be added once locations
-- exists, so it lives here rather than in CREATE TABLE maps. Deleting the room
-- clears it; deleting the map takes both rows with it.
ALTER TABLE maps ADD COLUMN IF NOT EXISTS start_location_id uuid;
DO $mig$ BEGIN
  ALTER TABLE maps
    ADD CONSTRAINT maps_start_location_fk
      FOREIGN KEY (start_location_id) REFERENCES locations(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $mig$;

-- A room's single group_id became a many-to-many. Migrate any existing rows
-- into location_group_assignments (in created_at order, so import order
-- becomes assignment order, and the room's one prior grouping lands as its
-- anchor) before dropping the column and the label's now-defunct default.
-- The guard makes this re-runnable on a database that has already converged.
DO $mig$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'locations' AND column_name = 'group_id') THEN
    INSERT INTO location_group_assignments (location_id, group_id)
      SELECT id, group_id FROM locations WHERE group_id IS NOT NULL ORDER BY created_at
      ON CONFLICT DO NOTHING;
    DROP TRIGGER IF EXISTS locations_group_same_map ON locations;
    DROP INDEX IF EXISTS locations_group_idx;
    ALTER TABLE locations DROP COLUMN group_id;
  END IF;
END $mig$;

ALTER TABLE location_labels DROP COLUMN IF EXISTS default_group_id;

-- the inline CHECK above is named, so adding it here twice is a no-op
DO $mig$ BEGIN
  ALTER TABLE groups
    ADD CONSTRAINT groups_default_size_positive CHECK (default_size IS NULL OR default_size > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $mig$;

DO $mig$ BEGIN
  ALTER TABLE groups
    ADD CONSTRAINT groups_display_style_valid
      CHECK (display_style IN ('rectangle', 'outline', 'loop'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $mig$;

-- the earlier version of this constraint didn't tolerate NULL; drop it before
-- re-adding, since a name collision would otherwise silently keep the old one
ALTER TABLE groups DROP CONSTRAINT IF EXISTS groups_body_padding_sane;

DO $mig$ BEGIN
  ALTER TABLE groups
    ADD CONSTRAINT groups_body_padding_sane
      CHECK (body_padding IS NULL OR (body_padding >= 0 AND body_padding <= 400));
EXCEPTION WHEN duplicate_object THEN NULL;
END $mig$;

CREATE INDEX IF NOT EXISTS groups_map_idx             ON groups(map_id);
CREATE INDEX IF NOT EXISTS groups_parent_idx          ON groups(parent_id);
CREATE INDEX IF NOT EXISTS locations_map_idx          ON locations(map_id);
CREATE INDEX IF NOT EXISTS locations_map_name_idx     ON locations(map_id, lower(name));
CREATE INDEX IF NOT EXISTS loc_group_assign_group_idx ON location_group_assignments(group_id);
CREATE INDEX IF NOT EXISTS connections_map_idx        ON connections(map_id);
CREATE INDEX IF NOT EXISTS connections_source_idx     ON connections(source_id);
CREATE INDEX IF NOT EXISTS connections_target_idx     ON connections(target_id);
CREATE INDEX IF NOT EXISTS conn_req_location_idx      ON connection_requirements(location_id);
CREATE INDEX IF NOT EXISTS location_labels_map_idx    ON location_labels(map_id);
CREATE INDEX IF NOT EXISTS connection_labels_map_idx  ON connection_labels(map_id);
CREATE INDEX IF NOT EXISTS loc_label_assign_label_idx  ON location_label_assignments(label_id);
CREATE INDEX IF NOT EXISTS conn_label_assign_label_idx ON connection_label_assignments(label_id);
CREATE INDEX IF NOT EXISTS conn_label_req_location_idx ON connection_label_requirements(location_id);
CREATE INDEX IF NOT EXISTS maps_start_location_idx       ON maps(start_location_id);
CREATE INDEX IF NOT EXISTS loc_label_restart_location_idx ON location_label_restarts(location_id);

-- updated_at -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION mapgraph_touch_updated_at() RETURNS trigger AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS maps_touch              ON maps;
DROP TRIGGER IF EXISTS groups_touch            ON groups;
DROP TRIGGER IF EXISTS locations_touch         ON locations;
DROP TRIGGER IF EXISTS connections_touch       ON connections;
DROP TRIGGER IF EXISTS location_labels_touch   ON location_labels;
DROP TRIGGER IF EXISTS connection_labels_touch ON connection_labels;

CREATE TRIGGER maps_touch              BEFORE UPDATE ON maps
  FOR EACH ROW EXECUTE FUNCTION mapgraph_touch_updated_at();
CREATE TRIGGER groups_touch            BEFORE UPDATE ON groups
  FOR EACH ROW EXECUTE FUNCTION mapgraph_touch_updated_at();
CREATE TRIGGER locations_touch         BEFORE UPDATE ON locations
  FOR EACH ROW EXECUTE FUNCTION mapgraph_touch_updated_at();
CREATE TRIGGER connections_touch       BEFORE UPDATE ON connections
  FOR EACH ROW EXECUTE FUNCTION mapgraph_touch_updated_at();
CREATE TRIGGER location_labels_touch   BEFORE UPDATE ON location_labels
  FOR EACH ROW EXECUTE FUNCTION mapgraph_touch_updated_at();
CREATE TRIGGER connection_labels_touch BEFORE UPDATE ON connection_labels
  FOR EACH ROW EXECUTE FUNCTION mapgraph_touch_updated_at();

-- Cross-map references are impossible by construction -------------------------
CREATE OR REPLACE FUNCTION mapgraph_check_connection_map() RETURNS trigger AS $fn$
DECLARE
  src_map uuid;
  tgt_map uuid;
BEGIN
  SELECT map_id INTO src_map FROM locations WHERE id = NEW.source_id;
  SELECT map_id INTO tgt_map FROM locations WHERE id = NEW.target_id;
  IF src_map IS NULL OR tgt_map IS NULL THEN
    RAISE EXCEPTION 'connection endpoints must exist';
  END IF;
  IF src_map <> NEW.map_id OR tgt_map <> NEW.map_id THEN
    RAISE EXCEPTION 'connection endpoints must belong to the same map';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS connections_same_map ON connections;
CREATE TRIGGER connections_same_map BEFORE INSERT OR UPDATE ON connections
  FOR EACH ROW EXECUTE FUNCTION mapgraph_check_connection_map();

CREATE OR REPLACE FUNCTION mapgraph_check_location_group_assignment() RETURNS trigger AS $fn$
DECLARE
  loc_map uuid;
  grp_map uuid;
BEGIN
  SELECT map_id INTO loc_map FROM locations WHERE id = NEW.location_id;
  SELECT map_id INTO grp_map FROM groups    WHERE id = NEW.group_id;
  IF loc_map IS NULL OR grp_map IS NULL OR loc_map <> grp_map THEN
    RAISE EXCEPTION 'a grouping membership must stay on one map';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS location_group_assignments_same_map ON location_group_assignments;
CREATE TRIGGER location_group_assignments_same_map
  BEFORE INSERT OR UPDATE ON location_group_assignments
  FOR EACH ROW EXECUTE FUNCTION mapgraph_check_location_group_assignment();

CREATE OR REPLACE FUNCTION mapgraph_check_group_parent_map() RETURNS trigger AS $fn$
DECLARE
  parent_map uuid;
BEGIN
  IF NEW.parent_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION 'a grouping cannot be its own parent';
  END IF;
  SELECT map_id INTO parent_map FROM groups WHERE id = NEW.parent_id;
  IF parent_map IS NULL OR parent_map <> NEW.map_id THEN
    RAISE EXCEPTION 'the parent grouping must belong to the same map';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS groups_parent_same_map ON groups;
CREATE TRIGGER groups_parent_same_map BEFORE INSERT OR UPDATE ON groups
  FOR EACH ROW EXECUTE FUNCTION mapgraph_check_group_parent_map();

CREATE OR REPLACE FUNCTION mapgraph_check_requirement_map() RETURNS trigger AS $fn$
DECLARE
  owner_map uuid;
  loc_map   uuid;
BEGIN
  SELECT map_id INTO loc_map FROM locations WHERE id = NEW.location_id;
  IF TG_TABLE_NAME = 'connection_requirements' THEN
    SELECT map_id INTO owner_map FROM connections WHERE id = NEW.connection_id;
  ELSE
    SELECT map_id INTO owner_map FROM connection_labels WHERE id = NEW.label_id;
  END IF;
  IF owner_map IS NULL OR loc_map IS NULL OR owner_map <> loc_map THEN
    RAISE EXCEPTION 'an unlock condition must reference a location on the same map';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS connection_requirements_same_map ON connection_requirements;
CREATE TRIGGER connection_requirements_same_map
  BEFORE INSERT OR UPDATE ON connection_requirements
  FOR EACH ROW EXECUTE FUNCTION mapgraph_check_requirement_map();

DROP TRIGGER IF EXISTS connection_label_requirements_same_map ON connection_label_requirements;
CREATE TRIGGER connection_label_requirements_same_map
  BEFORE INSERT OR UPDATE ON connection_label_requirements
  FOR EACH ROW EXECUTE FUNCTION mapgraph_check_requirement_map();

CREATE OR REPLACE FUNCTION mapgraph_check_location_label_restart() RETURNS trigger AS $fn$
DECLARE
  label_map uuid;
  loc_map   uuid;
BEGIN
  SELECT map_id INTO label_map FROM location_labels WHERE id = NEW.label_id;
  SELECT map_id INTO loc_map   FROM locations       WHERE id = NEW.location_id;
  IF label_map IS NULL OR loc_map IS NULL OR label_map <> loc_map THEN
    RAISE EXCEPTION 'a restart target must reference a location on the same map';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS location_label_restarts_same_map ON location_label_restarts;
CREATE TRIGGER location_label_restarts_same_map
  BEFORE INSERT OR UPDATE ON location_label_restarts
  FOR EACH ROW EXECUTE FUNCTION mapgraph_check_location_label_restart();

CREATE OR REPLACE FUNCTION mapgraph_check_map_start_location() RETURNS trigger AS $fn$
DECLARE loc_map uuid;
BEGIN
  /* the FK's ON DELETE SET NULL also lands here; NULL is always fine */
  IF NEW.start_location_id IS NULL THEN RETURN NEW; END IF;
  SELECT map_id INTO loc_map FROM locations WHERE id = NEW.start_location_id;
  IF loc_map IS NULL OR loc_map <> NEW.id THEN
    RAISE EXCEPTION 'the default trip start must belong to this map';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS maps_start_location_same_map ON maps;
CREATE TRIGGER maps_start_location_same_map BEFORE INSERT OR UPDATE ON maps
  FOR EACH ROW EXECUTE FUNCTION mapgraph_check_map_start_location();
`;

/** Applies the schema. Returns true when the database was empty beforehand. */
export async function ensureSchema(): Promise<boolean> {
  const { rows } = await query<{ fresh: boolean }>(
    `SELECT to_regclass('public.maps') IS NULL AS fresh`
  );
  const fresh = rows[0].fresh;
  await query(SCHEMA_SQL);
  console.log(fresh ? '[schema] created' : '[schema] verified');
  return fresh;
}
