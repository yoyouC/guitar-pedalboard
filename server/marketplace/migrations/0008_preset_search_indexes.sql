BEGIN;

ALTER TABLE marketplace_published_preset_search_projection
  ADD COLUMN IF NOT EXISTS resource_dependency_keys text[] NOT NULL DEFAULT '{}'::text[];

CREATE OR REPLACE FUNCTION marketplace_resource_dependency_keys(dependencies jsonb)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(array_agg(
    CASE dependency->>'kind'
      WHEN 'builtin' THEN 'builtin'
      ELSE concat_ws(':', 'tone3000', dependency->>'toneId', dependency->>'modelId')
    END
    ORDER BY dependency::text
  ), '{}'::text[])
  FROM jsonb_array_elements(dependencies) AS dependency
$$;

UPDATE marketplace_published_preset_search_projection AS projection
SET resource_dependency_keys = marketplace_resource_dependency_keys(revision.resource_dependencies)
FROM marketplace_published_presets AS preset
JOIN marketplace_published_preset_revisions AS revision
  ON revision.preset_id = preset.id AND revision.id = preset.current_revision_id
WHERE projection.preset_id = preset.id;

CREATE INDEX IF NOT EXISTS marketplace_preset_search_pedals_idx
  ON marketplace_published_preset_search_projection USING gin (pedal_ids);

CREATE INDEX IF NOT EXISTS marketplace_preset_search_resources_idx
  ON marketplace_published_preset_search_projection USING gin (resource_kinds);

CREATE INDEX IF NOT EXISTS marketplace_preset_search_resource_dependencies_idx
  ON marketplace_published_preset_search_projection USING gin (resource_dependency_keys);

CREATE INDEX IF NOT EXISTS marketplace_preset_search_amp_idx
  ON marketplace_published_preset_search_projection (amp_id, preset_id);

CREATE INDEX IF NOT EXISTS marketplace_preset_search_cab_idx
  ON marketplace_published_preset_search_projection (cab_id, preset_id);

CREATE INDEX IF NOT EXISTS marketplace_preset_tag_filter_idx
  ON marketplace_published_preset_tags (tag_id, preset_id);

COMMIT;
