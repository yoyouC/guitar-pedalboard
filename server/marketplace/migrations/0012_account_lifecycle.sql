BEGIN;

ALTER TABLE marketplace_members
  ADD COLUMN IF NOT EXISTS account_status text NOT NULL DEFAULT 'active';

ALTER TABLE marketplace_member_handle_claims
  ADD COLUMN IF NOT EXISTS handle_digest text;

UPDATE marketplace_member_handle_claims
SET handle_digest = encode(sha256(convert_to(handle, 'UTF8')), 'hex')
WHERE handle_digest IS NULL;

ALTER TABLE marketplace_member_handle_claims
  ALTER COLUMN handle_digest SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS marketplace_member_handle_claim_digest_idx
  ON marketplace_member_handle_claims (handle_digest);

CREATE OR REPLACE FUNCTION marketplace_set_handle_claim_digest()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.handle_digest := encode(sha256(convert_to(NEW.handle, 'UTF8')), 'hex');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS marketplace_set_handle_claim_digest
  ON marketplace_member_handle_claims;
CREATE TRIGGER marketplace_set_handle_claim_digest
BEFORE INSERT ON marketplace_member_handle_claims
FOR EACH ROW EXECUTE FUNCTION marketplace_set_handle_claim_digest();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_member_account_status'
  ) THEN
    ALTER TABLE marketplace_members
      ADD CONSTRAINT marketplace_member_account_status
      CHECK (account_status IN ('active', 'pending_deletion', 'tombstoned'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS marketplace_account_deletion_requests (
  member_id text PRIMARY KEY REFERENCES marketplace_members(id),
  requested_at timestamptz NOT NULL,
  purge_after timestamptz NOT NULL,
  CHECK (purge_after = requested_at + interval '30 days')
);

CREATE INDEX IF NOT EXISTS marketplace_account_deletion_due_idx
  ON marketplace_account_deletion_requests (purge_after, member_id);

CREATE TABLE IF NOT EXISTS marketplace_account_deletion_restorations (
  member_id text NOT NULL REFERENCES marketplace_account_deletion_requests(member_id)
    ON DELETE CASCADE,
  target_kind text NOT NULL CHECK (target_kind IN ('preset', 'collection')),
  target_id text NOT NULL,
  previous_visibility text NOT NULL CHECK (previous_visibility IN ('public', 'unlisted')),
  PRIMARY KEY (member_id, target_kind, target_id)
);

-- Immutable revisions may only be scrubbed by the due-account purge transaction.
-- IDs, ownership, timestamps and provenance remain immutable tombstone facts.
CREATE OR REPLACE FUNCTION marketplace_reject_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  purge_member_id text := nullif(
    current_setting('marketplace.account_purge_member_id', true),
    ''
  );
BEGIN
  IF TG_OP = 'UPDATE'
    AND purge_member_id IS NOT NULL
    AND OLD.id = NEW.id
    AND OLD.preset_id = NEW.preset_id
    AND OLD.schema_version = NEW.schema_version
    AND OLD.created_at = NEW.created_at
    AND NEW.rig = '{}'::jsonb
    AND NEW.resource_dependencies = '[]'::jsonb
    AND NEW.derived_attributes = '{}'::jsonb
    AND EXISTS (
      SELECT 1
      FROM marketplace_published_presets AS preset
      JOIN marketplace_members AS member ON member.id = preset.creator_id
      JOIN marketplace_account_deletion_requests AS request
        ON request.member_id = member.id
      WHERE preset.id = OLD.preset_id
        AND preset.creator_id = purge_member_id
        AND member.account_status = 'pending_deletion'
        AND request.purge_after <= clock_timestamp()
    ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'published preset revisions are append-only';
END;
$$;

COMMIT;
