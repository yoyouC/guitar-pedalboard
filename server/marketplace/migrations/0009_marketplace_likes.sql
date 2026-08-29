BEGIN;

CREATE TABLE IF NOT EXISTS marketplace_preset_likes (
  member_id text NOT NULL REFERENCES marketplace_members(id),
  preset_id text NOT NULL REFERENCES marketplace_published_presets(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, preset_id)
);

CREATE TABLE IF NOT EXISTS marketplace_collection_likes (
  member_id text NOT NULL REFERENCES marketplace_members(id),
  collection_id text NOT NULL REFERENCES marketplace_preset_collections(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, collection_id)
);

CREATE TABLE IF NOT EXISTS marketplace_preset_like_counts (
  preset_id text PRIMARY KEY REFERENCES marketplace_published_presets(id),
  like_count integer NOT NULL CHECK (like_count >= 0),
  computed_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS marketplace_collection_like_counts (
  collection_id text PRIMARY KEY REFERENCES marketplace_preset_collections(id),
  like_count integer NOT NULL CHECK (like_count >= 0),
  computed_at timestamptz NOT NULL
);

CREATE SEQUENCE IF NOT EXISTS marketplace_like_rank_version_seq;

CREATE TABLE IF NOT EXISTS marketplace_preset_like_count_history (
  preset_id text NOT NULL REFERENCES marketplace_published_presets(id),
  rank_version bigint NOT NULL,
  like_count integer NOT NULL CHECK (like_count >= 0),
  computed_at timestamptz NOT NULL,
  PRIMARY KEY (preset_id, rank_version)
);

CREATE TABLE IF NOT EXISTS marketplace_collection_like_count_history (
  collection_id text NOT NULL REFERENCES marketplace_preset_collections(id),
  rank_version bigint NOT NULL,
  like_count integer NOT NULL CHECK (like_count >= 0),
  computed_at timestamptz NOT NULL,
  PRIMARY KEY (collection_id, rank_version)
);

CREATE INDEX IF NOT EXISTS marketplace_preset_likes_member_idx
  ON marketplace_preset_likes (member_id, created_at DESC, preset_id DESC);

CREATE INDEX IF NOT EXISTS marketplace_collection_likes_member_idx
  ON marketplace_collection_likes (member_id, created_at DESC, collection_id DESC);

CREATE INDEX IF NOT EXISTS marketplace_preset_popular_idx
  ON marketplace_preset_like_counts (like_count DESC, preset_id DESC);

CREATE INDEX IF NOT EXISTS marketplace_collection_popular_idx
  ON marketplace_collection_like_counts (like_count DESC, collection_id DESC);

CREATE INDEX IF NOT EXISTS marketplace_preset_like_history_version_idx
  ON marketplace_preset_like_count_history (rank_version, preset_id);

CREATE INDEX IF NOT EXISTS marketplace_collection_like_history_version_idx
  ON marketplace_collection_like_count_history (rank_version, collection_id);

COMMIT;
