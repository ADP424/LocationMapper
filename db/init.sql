-- ============================================================================
--  MapGraph schema
--  maps ─┬─ groups ──┐
--        ├─ locations ┘ (a location may belong to at most one group)
--        └─ connections (source/target locations, optional unlock requirements)
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS maps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text        NOT NULL,
  description  text        NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- A visual grouping ("House", "Floor 3", "Old Town") drawn as a translucent
-- rounded rectangle behind its member locations.
CREATE TABLE IF NOT EXISTS groups (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  map_id       uuid        NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  -- a grouping may live inside another grouping (cycles are rejected by the API)
  parent_id    uuid                 REFERENCES groups(id) ON DELETE SET NULL,
  name         text        NOT NULL DEFAULT '',
  color        text        NOT NULL DEFAULT '',
  -- '' = follow the body colour
  text_color   text        NOT NULL DEFAULT '',
  notes        text        NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS locations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  map_id       uuid        NOT NULL REFERENCES maps(id)   ON DELETE CASCADE,
  group_id     uuid                 REFERENCES groups(id) ON DELETE SET NULL,
  name         text        NOT NULL DEFAULT '',
  kind         text        NOT NULL DEFAULT 'round-rectangle',
  layer        text        NOT NULL DEFAULT '',
  notes        text        NOT NULL DEFAULT '',
  color        text        NOT NULL DEFAULT '',
  text_color   text        NOT NULL DEFAULT '',
  visited      boolean     NOT NULL DEFAULT false,
  pinned       boolean     NOT NULL DEFAULT false,
  x            double precision,
  y            double precision,
  -- optional integer coordinates; any axis may be NULL ("no coordinate")
  coord_x      integer,
  coord_y      integer,
  coord_z      integer,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS connections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  map_id        uuid        NOT NULL REFERENCES maps(id)      ON DELETE CASCADE,
  source_id     uuid        NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  target_id     uuid        NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name          text        NOT NULL DEFAULT '',
  notes         text        NOT NULL DEFAULT '',
  travel_kind   text        NOT NULL DEFAULT 'default',
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
--  the locations / connections they are applied to. Every `default_*` column
--  that is '' (or NULL) means "no override" — applying the label leaves that
--  property untouched. Assigning a label stamps its defaults immediately;
--  since a later assignment can overwrite an earlier one's stamp, the
--  `applied_at` timestamp on the assignment tables records which was last.
-- ============================================================================

CREATE TABLE IF NOT EXISTS location_labels (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  map_id              uuid        NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  name                text        NOT NULL DEFAULT '',
  color               text        NOT NULL DEFAULT '',   -- the chip color
  notes               text        NOT NULL DEFAULT '',
  default_kind        text        NOT NULL DEFAULT '',   -- shape key
  default_color       text        NOT NULL DEFAULT '',   -- box fill
  default_text_color  text        NOT NULL DEFAULT '',
  default_layer       text        NOT NULL DEFAULT '',
  default_group_id    uuid                 REFERENCES groups(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS location_label_assignments (
  location_id uuid        NOT NULL REFERENCES locations(id)       ON DELETE CASCADE,
  label_id    uuid        NOT NULL REFERENCES location_labels(id) ON DELETE CASCADE,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, label_id)
);

CREATE TABLE IF NOT EXISTS connection_labels (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  map_id              uuid        NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  name                text        NOT NULL DEFAULT '',
  color               text        NOT NULL DEFAULT '',
  notes               text        NOT NULL DEFAULT '',
  default_color       text        NOT NULL DEFAULT '',   -- line color
  default_text_color  text        NOT NULL DEFAULT '',
  default_travel_kind text        NOT NULL DEFAULT '',   -- '' | default | solid | dashed | dotted
  default_direction   text        NOT NULL DEFAULT '',   -- '' | forward | backward | both | none
  default_weight      double precision CHECK (default_weight IS NULL OR default_weight > 0), -- NULL => no override
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

CREATE INDEX IF NOT EXISTS groups_map_idx       ON groups(map_id);
CREATE INDEX IF NOT EXISTS groups_parent_idx    ON groups(parent_id);
CREATE INDEX IF NOT EXISTS locations_map_idx    ON locations(map_id);
CREATE INDEX IF NOT EXISTS locations_group_idx  ON locations(group_id);
CREATE INDEX IF NOT EXISTS locations_map_name_idx ON locations(map_id, lower(name));
CREATE INDEX IF NOT EXISTS connections_map_idx    ON connections(map_id);
CREATE INDEX IF NOT EXISTS connections_source_idx ON connections(source_id);
CREATE INDEX IF NOT EXISTS connections_target_idx ON connections(target_id);
CREATE INDEX IF NOT EXISTS conn_req_location_idx  ON connection_requirements(location_id);
CREATE INDEX IF NOT EXISTS location_labels_map_idx     ON location_labels(map_id);
CREATE INDEX IF NOT EXISTS connection_labels_map_idx    ON connection_labels(map_id);
CREATE INDEX IF NOT EXISTS loc_label_assign_label_idx   ON location_label_assignments(label_id);
CREATE INDEX IF NOT EXISTS conn_label_assign_label_idx  ON connection_label_assignments(label_id);
CREATE INDEX IF NOT EXISTS conn_label_req_location_idx  ON connection_label_requirements(location_id);

CREATE OR REPLACE FUNCTION mapgraph_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS maps_touch        ON maps;
DROP TRIGGER IF EXISTS groups_touch      ON groups;
DROP TRIGGER IF EXISTS locations_touch   ON locations;
DROP TRIGGER IF EXISTS connections_touch ON connections;
DROP TRIGGER IF EXISTS location_labels_touch   ON location_labels;
DROP TRIGGER IF EXISTS connection_labels_touch ON connection_labels;

CREATE TRIGGER maps_touch        BEFORE UPDATE ON maps
  FOR EACH ROW EXECUTE FUNCTION mapgraph_touch_updated_at();
CREATE TRIGGER groups_touch      BEFORE UPDATE ON groups
  FOR EACH ROW EXECUTE FUNCTION mapgraph_touch_updated_at();
CREATE TRIGGER locations_touch   BEFORE UPDATE ON locations
  FOR EACH ROW EXECUTE FUNCTION mapgraph_touch_updated_at();
CREATE TRIGGER connections_touch BEFORE UPDATE ON connections
  FOR EACH ROW EXECUTE FUNCTION mapgraph_touch_updated_at();
CREATE TRIGGER location_labels_touch   BEFORE UPDATE ON location_labels
  FOR EACH ROW EXECUTE FUNCTION mapgraph_touch_updated_at();
CREATE TRIGGER connection_labels_touch BEFORE UPDATE ON connection_labels
  FOR EACH ROW EXECUTE FUNCTION mapgraph_touch_updated_at();

CREATE OR REPLACE FUNCTION mapgraph_check_connection_map() RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS connections_same_map ON connections;
CREATE TRIGGER connections_same_map BEFORE INSERT OR UPDATE ON connections
  FOR EACH ROW EXECUTE FUNCTION mapgraph_check_connection_map();

-- A location's group must live on the same map ------------------------------
CREATE OR REPLACE FUNCTION mapgraph_check_location_group() RETURNS trigger AS $$
DECLARE
  grp_map uuid;
BEGIN
  IF NEW.group_id IS NULL THEN RETURN NEW; END IF;
  SELECT map_id INTO grp_map FROM groups WHERE id = NEW.group_id;
  IF grp_map IS NULL OR grp_map <> NEW.map_id THEN
    RAISE EXCEPTION 'group must belong to the same map as the location';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS locations_group_same_map ON locations;
CREATE TRIGGER locations_group_same_map BEFORE INSERT OR UPDATE ON locations
  FOR EACH ROW EXECUTE FUNCTION mapgraph_check_location_group();

-- A grouping's parent must live on the same map -----------------------------
CREATE OR REPLACE FUNCTION mapgraph_check_group_parent_map() RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS groups_parent_same_map ON groups;
CREATE TRIGGER groups_parent_same_map BEFORE INSERT OR UPDATE ON groups
  FOR EACH ROW EXECUTE FUNCTION mapgraph_check_group_parent_map();

-- Unlock conditions must reference locations on the same map ---------------
CREATE OR REPLACE FUNCTION mapgraph_check_requirement_map() RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS connection_requirements_same_map ON connection_requirements;
CREATE TRIGGER connection_requirements_same_map
  BEFORE INSERT OR UPDATE ON connection_requirements
  FOR EACH ROW EXECUTE FUNCTION mapgraph_check_requirement_map();

DROP TRIGGER IF EXISTS connection_label_requirements_same_map ON connection_label_requirements;
CREATE TRIGGER connection_label_requirements_same_map
  BEFORE INSERT OR UPDATE ON connection_label_requirements
  FOR EACH ROW EXECUTE FUNCTION mapgraph_check_requirement_map();
