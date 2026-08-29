BEGIN;

CREATE INDEX IF NOT EXISTS marketplace_tags_merged_into_idx
  ON marketplace_tags (merged_into_id) WHERE merged_into_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS marketplace_tag_administration_audit (
  id text PRIMARY KEY,
  actor_auth_user_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('create_tag', 'edit_tag', 'deprecate_tag', 'merge_tag')),
  tag_id text NOT NULL REFERENCES marketplace_tags(id),
  target_tag_id text REFERENCES marketplace_tags(id),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL,
  CHECK ((action = 'merge_tag') = (target_tag_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS marketplace_tag_administration_audit_tag_idx
  ON marketplace_tag_administration_audit (tag_id, created_at, id);

COMMIT;
