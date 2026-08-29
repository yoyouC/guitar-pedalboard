BEGIN;

CREATE TABLE IF NOT EXISTS marketplace_moderation_reports (
  id text PRIMARY KEY,
  reporter_member_id text NOT NULL REFERENCES marketplace_members(id),
  target_kind text NOT NULL CHECK (target_kind IN ('preset', 'collection')),
  target_id text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('copyright', 'spam', 'impersonation', 'inappropriate')),
  details text NOT NULL CHECK (char_length(details) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at timestamptz NOT NULL,
  resolved_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS marketplace_moderation_reporter_target_idx
  ON marketplace_moderation_reports (reporter_member_id, target_kind, target_id);

CREATE INDEX IF NOT EXISTS marketplace_moderation_reports_queue_idx
  ON marketplace_moderation_reports (status, created_at, id);

CREATE TABLE IF NOT EXISTS marketplace_infringement_notices (
  id text PRIMARY KEY,
  claimant_name text NOT NULL CHECK (char_length(claimant_name) BETWEEN 1 AND 160),
  claimant_email text NOT NULL CHECK (char_length(claimant_email) BETWEEN 3 AND 320),
  target_kind text NOT NULL CHECK (target_kind IN ('preset', 'collection')),
  target_id text NOT NULL,
  rights_statement text NOT NULL CHECK (char_length(rights_statement) BETWEEN 20 AND 4000),
  good_faith boolean NOT NULL CHECK (good_faith),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at timestamptz NOT NULL,
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS marketplace_infringement_notices_queue_idx
  ON marketplace_infringement_notices (status, created_at, id);

CREATE TABLE IF NOT EXISTS marketplace_moderation_actions (
  id text PRIMARY KEY,
  action_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  actor_auth_user_id text NOT NULL,
  action text NOT NULL CHECK (action IN (
    'hide', 'restore', 'ban', 'unban',
    'resolve_report', 'resolve_notice', 'uphold_appeal', 'reject_appeal'
  )),
  subject_kind text NOT NULL CHECK (subject_kind IN (
    'preset', 'collection', 'member', 'report', 'notice', 'appeal'
  )),
  subject_id text NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 2000),
  previous_visibility text CHECK (
    previous_visibility IS NULL
    OR previous_visibility IN ('public', 'unlisted', 'withdrawn')
  ),
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS marketplace_moderation_actions_subject_idx
  ON marketplace_moderation_actions (subject_kind, subject_id, action_order DESC);

CREATE TABLE IF NOT EXISTS marketplace_moderation_appeals (
  id text PRIMARY KEY,
  action_id text NOT NULL UNIQUE REFERENCES marketplace_moderation_actions(id),
  author_member_id text NOT NULL REFERENCES marketplace_members(id),
  statement text NOT NULL CHECK (char_length(statement) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'upheld', 'rejected')),
  created_at timestamptz NOT NULL,
  resolved_at timestamptz,
  resolution_action_id text UNIQUE REFERENCES marketplace_moderation_actions(id)
);

CREATE INDEX IF NOT EXISTS marketplace_moderation_appeals_queue_idx
  ON marketplace_moderation_appeals (status, created_at, id);

COMMIT;
