BEGIN;

CREATE TABLE IF NOT EXISTS marketplace_write_rate_buckets (
  operation text NOT NULL CHECK (operation IN ('publish', 'revision', 'like', 'report')),
  scope text NOT NULL CHECK (scope IN ('member', 'network')),
  subject_hash text NOT NULL,
  tokens double precision NOT NULL CHECK (tokens >= 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (operation, scope, subject_hash)
);

COMMIT;
