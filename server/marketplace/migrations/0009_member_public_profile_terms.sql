BEGIN;

ALTER TABLE marketplace_members
  ADD COLUMN IF NOT EXISTS terms_accepted_version text,
  ADD COLUMN IF NOT EXISTS public_profile_completed_at timestamptz;

COMMIT;
