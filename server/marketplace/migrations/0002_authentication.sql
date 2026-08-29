BEGIN;

CREATE TABLE IF NOT EXISTS marketplace_auth_users (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL DEFAULT false,
  image text,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS marketplace_auth_sessions (
  id text PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES marketplace_auth_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS marketplace_auth_sessions_user_idx
  ON marketplace_auth_sessions ("userId");

CREATE TABLE IF NOT EXISTS marketplace_auth_accounts (
  id text PRIMARY KEY,
  issuer text NOT NULL,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES marketplace_auth_users(id) ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  scope text,
  password text,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  UNIQUE (issuer, "accountId")
);

CREATE INDEX IF NOT EXISTS marketplace_auth_accounts_user_idx
  ON marketplace_auth_accounts ("userId");

CREATE TABLE IF NOT EXISTS marketplace_auth_verifications (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS marketplace_auth_verifications_identifier_idx
  ON marketplace_auth_verifications (identifier);

COMMIT;
