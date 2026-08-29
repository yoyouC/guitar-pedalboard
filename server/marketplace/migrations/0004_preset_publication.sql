BEGIN;

CREATE TABLE IF NOT EXISTS marketplace_tags (
  id text PRIMARY KEY,
  dimension text NOT NULL,
  name_zh text NOT NULL,
  name_en text NOT NULL,
  aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated', 'merged')),
  merged_into_id text REFERENCES marketplace_tags(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'merged' OR merged_into_id IS NULL),
  CHECK (status <> 'merged' OR merged_into_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS marketplace_published_preset_tags (
  preset_id text NOT NULL REFERENCES marketplace_published_presets(id),
  tag_id text NOT NULL REFERENCES marketplace_tags(id),
  PRIMARY KEY (preset_id, tag_id)
);

CREATE TABLE IF NOT EXISTS marketplace_published_preset_search_projection (
  preset_id text PRIMARY KEY REFERENCES marketplace_published_presets(id),
  pedal_ids text[] NOT NULL,
  amp_id text NOT NULL,
  amp_model_key text NOT NULL,
  cab_id text NOT NULL,
  resource_kinds text[] NOT NULL,
  projected_at timestamptz NOT NULL
);

INSERT INTO marketplace_tags (id, dimension, name_zh, name_en, aliases)
VALUES
  ('tone-clean', 'tone', '清音', 'Clean', '["clean tone"]'::jsonb),
  ('tone-crunch', 'tone', 'Crunch', 'Crunch', '["crunch tone"]'::jsonb),
  ('tone-high-gain', 'tone', '高增益', 'High Gain', '["high-gain", "distortion"]'::jsonb),
  ('genre-blues', 'genre', '布鲁斯', 'Blues', '["blues"]'::jsonb),
  ('genre-rock', 'genre', '摇滚', 'Rock', '["rock"]'::jsonb),
  ('use-live', 'use', '现场', 'Live', '["stage"]'::jsonb),
  ('use-recording', 'use', '录音', 'Recording', '["studio"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

COMMIT;
