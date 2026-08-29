BEGIN;

CREATE TABLE IF NOT EXISTS marketplace_preset_collections (
  id text PRIMARY KEY,
  creator_id text NOT NULL REFERENCES marketplace_members(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  visibility text NOT NULL CHECK (visibility IN ('public', 'unlisted', 'withdrawn', 'hidden')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketplace_preset_collection_tags (
  collection_id text NOT NULL REFERENCES marketplace_preset_collections(id),
  tag_id text NOT NULL REFERENCES marketplace_tags(id),
  PRIMARY KEY (collection_id, tag_id)
);

CREATE TABLE IF NOT EXISTS marketplace_preset_collection_items (
  collection_id text NOT NULL REFERENCES marketplace_preset_collections(id),
  position integer NOT NULL CHECK (position >= 0),
  preset_id text NOT NULL,
  revision_id text NOT NULL,
  PRIMARY KEY (collection_id, position),
  UNIQUE (collection_id, preset_id, revision_id),
  FOREIGN KEY (preset_id, revision_id)
    REFERENCES marketplace_published_preset_revisions(preset_id, id)
);

CREATE INDEX IF NOT EXISTS marketplace_public_collection_created_idx
  ON marketplace_preset_collections (created_at DESC, id DESC)
  WHERE visibility = 'public';

CREATE INDEX IF NOT EXISTS marketplace_collection_item_source_idx
  ON marketplace_preset_collection_items (preset_id, revision_id);

COMMIT;
