BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

CREATE INDEX IF NOT EXISTS marketplace_preset_title_trgm_idx
  ON marketplace_published_presets USING gin (lower(title) public.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS marketplace_preset_description_trgm_idx
  ON marketplace_published_presets USING gin (lower(description) public.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS marketplace_collection_title_trgm_idx
  ON marketplace_preset_collections USING gin (lower(title) public.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS marketplace_collection_description_trgm_idx
  ON marketplace_preset_collections USING gin (lower(description) public.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS marketplace_member_handle_trgm_idx
  ON marketplace_members USING gin (lower(handle) public.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS marketplace_member_display_name_trgm_idx
  ON marketplace_members USING gin (lower(display_name) public.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS marketplace_tag_name_zh_trgm_idx
  ON marketplace_tags USING gin (lower(name_zh) public.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS marketplace_tag_name_en_trgm_idx
  ON marketplace_tags USING gin (lower(name_en) public.gin_trgm_ops);

COMMIT;
