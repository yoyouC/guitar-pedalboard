import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('member public-profile migration persists terms and explicit completion', async () => {
  const sql = await readFile(
    new URL('../server/marketplace/migrations/0009_member_public_profile_terms.sql', import.meta.url),
    'utf8',
  );
  assert.match(sql, /terms_accepted_version text/);
  assert.match(sql, /public_profile_completed_at timestamptz/);
  assert.doesNotMatch(sql, /email|password|token/i);
});

