import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('publication migration owns controlled tags and rebuildable Rig filter projection', async () => {
  const sql = await readFile(
    new URL('../server/marketplace/migrations/0004_preset_publication.sql', import.meta.url),
    'utf8',
  );

  assert.match(sql, /CREATE TABLE IF NOT EXISTS marketplace_tags/);
  assert.match(sql, /status IN \('active', 'deprecated', 'merged'\)/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS marketplace_published_preset_tags/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS marketplace_published_preset_search_projection/);
  assert.match(sql, /pedal_ids text\[\] NOT NULL/);
  assert.match(sql, /amp_model_key text NOT NULL/);
  assert.match(sql, /resource_kinds text\[\] NOT NULL/);
  assert.match(sql, /^BEGIN;/m);
  assert.match(sql, /COMMIT;\s*$/);
});
