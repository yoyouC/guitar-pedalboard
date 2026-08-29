BEGIN;

ALTER TABLE marketplace_published_presets
  ADD COLUMN IF NOT EXISTS source_preset_id text,
  ADD COLUMN IF NOT EXISTS source_revision_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_remix_source_pair_check'
  ) THEN
    ALTER TABLE marketplace_published_presets
      ADD CONSTRAINT marketplace_remix_source_pair_check
      CHECK ((source_preset_id IS NULL) = (source_revision_id IS NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_remix_source_preset_fk'
  ) THEN
    ALTER TABLE marketplace_published_presets
      ADD CONSTRAINT marketplace_remix_source_preset_fk
      FOREIGN KEY (source_preset_id)
      REFERENCES marketplace_published_presets(id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_remix_source_revision_fk'
  ) THEN
    ALTER TABLE marketplace_published_presets
      ADD CONSTRAINT marketplace_remix_source_revision_fk
      FOREIGN KEY (source_preset_id, source_revision_id)
      REFERENCES marketplace_published_preset_revisions(preset_id, id);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION marketplace_reject_remix_source_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.source_preset_id IS DISTINCT FROM NEW.source_preset_id
    OR OLD.source_revision_id IS DISTINCT FROM NEW.source_revision_id THEN
    RAISE EXCEPTION 'Remix provenance is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS marketplace_remix_source_immutable
  ON marketplace_published_presets;
CREATE TRIGGER marketplace_remix_source_immutable
BEFORE UPDATE OF source_preset_id, source_revision_id ON marketplace_published_presets
FOR EACH ROW EXECUTE FUNCTION marketplace_reject_remix_source_mutation();

CREATE INDEX IF NOT EXISTS marketplace_remix_source_idx
  ON marketplace_published_presets (source_preset_id, source_revision_id)
  WHERE source_preset_id IS NOT NULL;

COMMIT;
