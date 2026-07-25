-- ============================================================================
--  MapGraph schema
--  A "map" holds Locations (nodes) and Connections (edges).
--  Connections carry independent source/target arrowheads, may be ephemeral
--  (drawn as detached stubs) and may be locked until other Locations are seen.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS maps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text        NOT NULL,
  description  text        NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- `kind`  : node shape key (round-rectangle, hexagon, diamond, star, ...)
-- `layer` : free-form grouping (Floor 3, Underground, Downtown, ...)
-- `x`/`y` : persisted layout coordinates (NULL => let the layout engine decide)
CREATE TABLE IF NOT EXISTS locations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  map_id       uuid        NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  name         text        NOT NULL DEFAULT '',
  kind         text        NOT NULL DEFAULT 'round-rectangle',
  layer        text        NOT NULL DEFAULT '',
  notes        text        NOT NULL DEFAULT '',
  color        text        NOT NULL DEFAULT '',   -- box fill,  '' => theme default
  text_color   text        NOT NULL DEFAULT '',   -- label ink, '' => theme default
  visited      boolean     NOT NULL DEFAULT false,
  pinned       boolean     NOT NULL DEFAULT false,
  x            double precision,
  y            double precision,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- `arrow_source` / `arrow_target` : which ends get arrowheads (both may be false)
-- `travel_kind`                   : line style key (solid | dashed | dotted)
CREATE TABLE IF NOT EXISTS connections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  map_id        uuid        NOT NULL REFERENCES maps(id)      ON DELETE CASCADE,
  source_id     uuid        NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  target_id     uuid        NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name          text        NOT NULL DEFAULT '',
  notes         text        NOT NULL DEFAULT '',
  travel_kind   text        NOT NULL DEFAULT 'solid',
  color         text        NOT NULL DEFAULT '',
  text_color    text        NOT NULL DEFAULT '',
  arrow_source  boolean     NOT NULL DEFAULT false,
  arrow_target  boolean     NOT NULL DEFAULT true,
  ephemeral     boolean     NOT NULL DEFAULT false,
  locked        boolean     NOT NULL DEFAULT false,
  lock_note     text        NOT NULL DEFAULT '',
  weight        double precision NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- "locked until location X has been visited" (AND over all rows)
CREATE TABLE IF NOT EXISTS connection_requirements (
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  location_id   uuid NOT NULL REFERENCES locations(id)   ON DELETE CASCADE,
  PRIMARY KEY (connection_id, location_id)
);

CREATE INDEX IF NOT EXISTS locations_map_idx      ON locations(map_id);
CREATE INDEX IF NOT EXISTS locations_map_name_idx ON locations(map_id, lower(name));
CREATE INDEX IF NOT EXISTS connections_map_idx    ON connections(map_id);
CREATE INDEX IF NOT EXISTS connections_source_idx ON connections(source_id);
CREATE INDEX IF NOT EXISTS connections_target_idx ON connections(target_id);
CREATE INDEX IF NOT EXISTS conn_req_location_idx  ON connection_requirements(location_id);

CREATE OR REPLACE FUNCTION mapgraph_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS maps_touch        ON maps;
DROP TRIGGER IF EXISTS locations_touch   ON locations;
DROP TRIGGER IF EXISTS connections_touch ON connections;

CREATE TRIGGER maps_touch        BEFORE UPDATE ON maps
  FOR EACH ROW EXECUTE FUNCTION mapgraph_touch_updated_at();
CREATE TRIGGER locations_touch   BEFORE UPDATE ON locations
  FOR EACH ROW EXECUTE FUNCTION mapgraph_touch_updated_at();
CREATE TRIGGER connections_touch BEFORE UPDATE ON connections
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
