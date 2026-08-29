import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { createPlatformAuth } from '../server/auth/betterAuth.ts';

test('PostgreSQL auth migration contains every Better Auth model and field', async () => {
  const auth = createPlatformAuth({
    baseURL: 'https://pedalboard.test',
    secret: 'test-only-secret-at-least-thirty-two-characters',
    database: memoryAdapter({
      marketplace_auth_users: [],
      marketplace_auth_sessions: [],
      marketplace_auth_accounts: [],
      marketplace_auth_verifications: [],
    }),
    sendMagicLink: async () => {},
    sendEmailVerification: async () => {},
  });
  const context = await auth.$context;
  const sql = await readFile(new URL(
    '../server/marketplace/migrations/0002_authentication.sql',
    import.meta.url,
  ), 'utf8');

  for (const table of Object.values(context.tables)) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table.modelName}`));
    for (const field of Object.values(table.fields)) {
      const escapedName = field.fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.match(sql, new RegExp(`(?:"${escapedName}"|\\b${escapedName}\\b)\\s`));
    }
  }
});
