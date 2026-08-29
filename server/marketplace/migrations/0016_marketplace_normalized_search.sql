BEGIN;

ALTER TABLE marketplace_published_presets ADD COLUMN IF NOT EXISTS search_text text;
ALTER TABLE marketplace_preset_collections ADD COLUMN IF NOT EXISTS search_text text;
ALTER TABLE marketplace_members ADD COLUMN IF NOT EXISTS search_text text;
ALTER TABLE marketplace_tags ADD COLUMN IF NOT EXISTS search_text text;

DROP INDEX IF EXISTS marketplace_preset_title_trgm_idx;
DROP INDEX IF EXISTS marketplace_preset_description_trgm_idx;
DROP INDEX IF EXISTS marketplace_collection_title_trgm_idx;
DROP INDEX IF EXISTS marketplace_collection_description_trgm_idx;
DROP INDEX IF EXISTS marketplace_member_handle_trgm_idx;
DROP INDEX IF EXISTS marketplace_member_display_name_trgm_idx;
DROP INDEX IF EXISTS marketplace_tag_name_zh_trgm_idx;
DROP INDEX IF EXISTS marketplace_tag_name_name_en_trgm_idx;
DROP INDEX IF EXISTS marketplace_tag_name_en_trgm_idx;

CREATE INDEX marketplace_preset_search_text_trgm_idx
  ON marketplace_published_presets USING gin (search_text public.gin_trgm_ops);
CREATE INDEX marketplace_collection_search_text_trgm_idx
  ON marketplace_preset_collections USING gin (search_text public.gin_trgm_ops);
CREATE INDEX marketplace_member_search_text_trgm_idx
  ON marketplace_members USING gin (search_text public.gin_trgm_ops);
CREATE INDEX marketplace_tag_search_text_trgm_idx
  ON marketplace_tags USING gin (search_text public.gin_trgm_ops);

-- NULL means the application projection is not yet rebuilt. These tiny partial
-- indexes make the correctness-preserving fallback cheap once most rows are projected.
CREATE INDEX IF NOT EXISTS marketplace_preset_missing_search_text_idx
  ON marketplace_published_presets (id) WHERE search_text IS NULL;
CREATE INDEX IF NOT EXISTS marketplace_collection_missing_search_text_idx
  ON marketplace_preset_collections (id) WHERE search_text IS NULL;
CREATE INDEX IF NOT EXISTS marketplace_member_missing_search_text_idx
  ON marketplace_members (id) WHERE search_text IS NULL;
CREATE INDEX IF NOT EXISTS marketplace_tag_missing_search_text_idx
  ON marketplace_tags (id) WHERE search_text IS NULL;

CREATE OR REPLACE FUNCTION marketplace_invalidate_search_text()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_text := NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS marketplace_preset_invalidate_search_text ON marketplace_published_presets;
CREATE TRIGGER marketplace_preset_invalidate_search_text
  BEFORE UPDATE OF title, description ON marketplace_published_presets
  FOR EACH ROW EXECUTE FUNCTION marketplace_invalidate_search_text();

DROP TRIGGER IF EXISTS marketplace_collection_invalidate_search_text ON marketplace_preset_collections;
CREATE TRIGGER marketplace_collection_invalidate_search_text
  BEFORE UPDATE OF title, description ON marketplace_preset_collections
  FOR EACH ROW EXECUTE FUNCTION marketplace_invalidate_search_text();

DROP TRIGGER IF EXISTS marketplace_member_invalidate_search_text ON marketplace_members;
CREATE TRIGGER marketplace_member_invalidate_search_text
  BEFORE UPDATE OF handle, display_name ON marketplace_members
  FOR EACH ROW EXECUTE FUNCTION marketplace_invalidate_search_text();

DROP TRIGGER IF EXISTS marketplace_tag_invalidate_search_text ON marketplace_tags;
CREATE TRIGGER marketplace_tag_invalidate_search_text
  BEFORE UPDATE OF name_zh, name_en, aliases ON marketplace_tags
  FOR EACH ROW EXECUTE FUNCTION marketplace_invalidate_search_text();

COMMIT;
