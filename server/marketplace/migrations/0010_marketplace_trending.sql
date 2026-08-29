BEGIN;

ALTER TABLE marketplace_members
  ADD COLUMN IF NOT EXISTS community_status text NOT NULL DEFAULT 'active';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_member_community_status'
  ) THEN
    ALTER TABLE marketplace_members
      ADD CONSTRAINT marketplace_member_community_status
      CHECK (community_status IN ('active', 'banned'));
  END IF;
END $$;

CREATE SEQUENCE IF NOT EXISTS marketplace_trending_rank_version_seq;

CREATE TABLE IF NOT EXISTS marketplace_trending_rebuilds (
  rank_version bigint PRIMARY KEY,
  computed_at timestamptz NOT NULL,
  window_hours integer NOT NULL CHECK (window_hours > 0),
  half_life_hours integer NOT NULL CHECK (half_life_hours > 0)
);

CREATE TABLE IF NOT EXISTS marketplace_preset_trending_snapshots (
  rank_version bigint NOT NULL REFERENCES marketplace_trending_rebuilds(rank_version),
  preset_id text NOT NULL REFERENCES marketplace_published_presets(id),
  trend_score double precision NOT NULL CHECK (trend_score > 0),
  valid_like_count integer NOT NULL CHECK (valid_like_count > 0),
  PRIMARY KEY (rank_version, preset_id)
);

CREATE TABLE IF NOT EXISTS marketplace_collection_trending_snapshots (
  rank_version bigint NOT NULL REFERENCES marketplace_trending_rebuilds(rank_version),
  collection_id text NOT NULL REFERENCES marketplace_preset_collections(id),
  trend_score double precision NOT NULL CHECK (trend_score > 0),
  valid_like_count integer NOT NULL CHECK (valid_like_count > 0),
  PRIMARY KEY (rank_version, collection_id)
);

CREATE INDEX IF NOT EXISTS marketplace_preset_trending_rank_idx
  ON marketplace_preset_trending_snapshots
  (rank_version, trend_score DESC, preset_id DESC);

CREATE INDEX IF NOT EXISTS marketplace_collection_trending_rank_idx
  ON marketplace_collection_trending_snapshots
  (rank_version, trend_score DESC, collection_id DESC);

COMMIT;
