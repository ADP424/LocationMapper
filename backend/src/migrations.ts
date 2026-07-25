import { query } from './db';

export const SCHEMA_SQL = /* sql */ `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS maps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text        NOT NULL,
  description  text        NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS locations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  map_id       uuid        NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
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

CREATE OR REPLACE FUNCTION mapgraph_touch_updated_at() RETURNS trigger AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS maps_touch        ON maps;
DROP TRIGGER IF EXISTS locations_touch   ON locations;
DROP TRIGGER IF EXISTS connections_touch ON connections;

CREATE TRIGGER maps_touch        BEFORE UPDATE ON maps
  FOR EACH ROW EXECUTE FUNCTION mapgraph_touch_updated_at();
CREATE TRIGGER locations_touch   BEFORE UPDATE ON locations
  FOR EACH ROW EXECUTE FUNCTION mapgraph_touch_updated_at();
CREATE TRIGGER connections_touch BEFORE UPDATE ON connections
  FOR EACH ROW EXECUTE FUNCTION mapgraph_touch_updated_at();

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
`;

/**
 * Additive, idempotent upgrades for databases created by earlier versions.
 *  - per-element text colours / connection line colours
 *  - independent source/target arrowheads replacing the old `bidirectional` flag
 *  - `kind` / `travel_kind` now store shape + line-style keys
 */
export const UPGRADE_SQL = /* sql */ `
ALTER TABLE locations   ADD COLUMN IF NOT EXISTS text_color   text NOT NULL DEFAULT '';
ALTER TABLE locations   ALTER COLUMN kind SET DEFAULT 'round-rectangle';

ALTER TABLE connections ADD COLUMN IF NOT EXISTS color        text NOT NULL DEFAULT '';
ALTER TABLE connections ADD COLUMN IF NOT EXISTS text_color   text NOT NULL DEFAULT '';
ALTER TABLE connections ADD COLUMN IF NOT EXISTS arrow_source boolean NOT NULL DEFAULT false;
ALTER TABLE connections ADD COLUMN IF NOT EXISTS arrow_target boolean NOT NULL DEFAULT true;
ALTER TABLE connections ALTER COLUMN travel_kind SET DEFAULT 'solid';

DO $upgrade$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'connections' AND column_name = 'bidirectional'
  ) THEN
    UPDATE connections SET arrow_source = true WHERE bidirectional;
    ALTER TABLE connections DROP COLUMN bidirectional;
  END IF;
END
$upgrade$;

-- Legacy free-text classifications become neutral shape / line-style keys.
UPDATE locations SET kind = 'round-rectangle'
 WHERE kind NOT IN ('ellipse','triangle','round-triangle','rectangle','round-rectangle',
                    'cut-rectangle','barrel','rhomboid','diamond','round-diamond',
                    'pentagon','hexagon','round-hexagon','heptagon','octagon','star','tag','vee');

UPDATE connections SET travel_kind = 'dotted' WHERE travel_kind = 'stairs';
UPDATE connections SET travel_kind = 'solid'  WHERE travel_kind NOT IN ('solid','dashed','dotted');
`;

export async function migrate() {
  await query(SCHEMA_SQL);
  await query(UPGRADE_SQL);
  console.log('[migrate] schema ensured');
}
