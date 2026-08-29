BEGIN;

ALTER TABLE marketplace_moderation_reports
  DROP CONSTRAINT IF EXISTS marketplace_moderation_reports_target_kind_check;

ALTER TABLE marketplace_moderation_reports
  ADD CONSTRAINT marketplace_moderation_reports_target_kind_check
  CHECK (target_kind IN ('preset', 'collection', 'member'));

COMMIT;
