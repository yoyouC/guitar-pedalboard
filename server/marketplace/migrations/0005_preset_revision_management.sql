BEGIN;

ALTER TABLE marketplace_published_preset_revisions
  ADD COLUMN IF NOT EXISTS derived_attributes jsonb;

-- Existing #24 revisions predate the frozen projection snapshot. The append-only
-- trigger is restored in the same transaction immediately after this one-time backfill.
ALTER TABLE marketplace_published_preset_revisions
  DISABLE TRIGGER marketplace_preset_revision_immutable;

UPDATE marketplace_published_preset_revisions AS revision
SET derived_attributes = jsonb_build_object(
  'pedalIds', projection.pedal_ids,
  'ampId', projection.amp_id,
  'ampModelKey', projection.amp_model_key,
  'cabId', projection.cab_id,
  'resourceKinds', projection.resource_kinds
)
FROM marketplace_published_presets AS preset
JOIN marketplace_published_preset_search_projection AS projection
  ON projection.preset_id = preset.id
WHERE revision.preset_id = preset.id
  AND revision.id = preset.current_revision_id
  AND revision.derived_attributes IS NULL;

ALTER TABLE marketplace_published_preset_revisions
  ENABLE TRIGGER marketplace_preset_revision_immutable;

ALTER TABLE marketplace_published_preset_revisions
  ALTER COLUMN derived_attributes SET NOT NULL;

CREATE INDEX IF NOT EXISTS marketplace_preset_revision_history_idx
  ON marketplace_published_preset_revisions (preset_id, created_at DESC, id DESC);

COMMIT;
