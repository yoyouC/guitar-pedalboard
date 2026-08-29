BEGIN;

CREATE TABLE IF NOT EXISTS marketplace_members (
  id text PRIMARY KEY,
  handle text NOT NULL UNIQUE,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketplace_published_presets (
  id text PRIMARY KEY,
  creator_id text NOT NULL REFERENCES marketplace_members(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  visibility text NOT NULL CHECK (visibility IN ('public', 'unlisted', 'withdrawn', 'hidden')),
  current_revision_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketplace_published_preset_revisions (
  id text PRIMARY KEY,
  preset_id text NOT NULL REFERENCES marketplace_published_presets(id),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  resource_dependencies jsonb NOT NULL,
  rig jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (preset_id, id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_current_revision_fk'
  ) THEN
    ALTER TABLE marketplace_published_presets
      ADD CONSTRAINT marketplace_current_revision_fk
      FOREIGN KEY (id, current_revision_id)
      REFERENCES marketplace_published_preset_revisions(preset_id, id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS marketplace_public_preset_created_idx
  ON marketplace_published_presets (created_at DESC, id DESC)
  WHERE visibility = 'public';

CREATE OR REPLACE FUNCTION marketplace_reject_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'published preset revisions are append-only';
END;
$$;

DROP TRIGGER IF EXISTS marketplace_preset_revision_immutable
  ON marketplace_published_preset_revisions;
CREATE TRIGGER marketplace_preset_revision_immutable
BEFORE UPDATE OR DELETE ON marketplace_published_preset_revisions
FOR EACH ROW EXECUTE FUNCTION marketplace_reject_revision_mutation();

COMMIT;
