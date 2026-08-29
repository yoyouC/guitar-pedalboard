BEGIN;

ALTER TABLE marketplace_members
  ADD COLUMN IF NOT EXISTS bio text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS avatar_url text,
  ADD COLUMN IF NOT EXISTS handle_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_member_handle_format'
  ) THEN
    ALTER TABLE marketplace_members
      ADD CONSTRAINT marketplace_member_handle_format
      CHECK (handle ~ '^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_member_display_name_length'
  ) THEN
    ALTER TABLE marketplace_members
      ADD CONSTRAINT marketplace_member_display_name_length
      CHECK (char_length(display_name) BETWEEN 1 AND 80);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_member_bio_length'
  ) THEN
    ALTER TABLE marketplace_members
      ADD CONSTRAINT marketplace_member_bio_length
      CHECK (char_length(bio) <= 500);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS marketplace_member_handle_claims (
  handle text PRIMARY KEY,
  member_id text NOT NULL REFERENCES marketplace_members(id),
  claimed_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO marketplace_member_handle_claims (handle, member_id, claimed_at)
SELECT handle, id, created_at FROM marketplace_members
ON CONFLICT (handle) DO NOTHING;

CREATE INDEX IF NOT EXISTS marketplace_member_handle_claims_member_idx
  ON marketplace_member_handle_claims (member_id);

CREATE TABLE IF NOT EXISTS marketplace_member_auth_identities (
  auth_user_id text PRIMARY KEY REFERENCES marketplace_auth_users(id) ON DELETE CASCADE,
  member_id text NOT NULL UNIQUE REFERENCES marketplace_members(id),
  linked_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
