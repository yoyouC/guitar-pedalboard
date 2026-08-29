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

test('revision management migration indexes immutable history without weakening its trigger', async () => {
  const [base, management] = await Promise.all([
    readFile(new URL('../server/marketplace/migrations/0001_published_presets.sql', import.meta.url), 'utf8'),
    readFile(new URL('../server/marketplace/migrations/0005_preset_revision_management.sql', import.meta.url), 'utf8'),
  ]);

  assert.match(base, /BEFORE UPDATE OR DELETE ON marketplace_published_preset_revisions/);
  assert.match(management, /marketplace_preset_revision_history_idx/);
  assert.match(management, /preset_id, created_at DESC, id DESC/);
  assert.match(management, /ADD COLUMN IF NOT EXISTS derived_attributes jsonb/);
  assert.match(management, /revision\.id = preset\.current_revision_id/);
  assert.match(management, /ALTER COLUMN derived_attributes SET NOT NULL/);
  const disableTrigger = management.indexOf('DISABLE TRIGGER marketplace_preset_revision_immutable');
  const backfill = management.indexOf('UPDATE marketplace_published_preset_revisions');
  const enableTrigger = management.indexOf('ENABLE TRIGGER marketplace_preset_revision_immutable');
  assert.equal(disableTrigger >= 0, true);
  assert.equal(disableTrigger < backfill && backfill < enableTrigger, true);
  assert.doesNotMatch(management, /DROP TRIGGER|ON DELETE CASCADE/);
});

test('Remix provenance migration keeps a fixed source work and revision without cascades', async () => {
  const sql = await readFile(
    new URL('../server/marketplace/migrations/0006_preset_remix_provenance.sql', import.meta.url),
    'utf8',
  );

  assert.match(sql, /source_preset_id text/);
  assert.match(sql, /source_revision_id text/);
  assert.match(sql, /FOREIGN KEY \(source_preset_id, source_revision_id\)/);
  assert.match(sql, /REFERENCES marketplace_published_preset_revisions\(preset_id, id\)/);
  assert.match(sql, /marketplace_remix_source_pair_check/);
  assert.match(sql, /marketplace_reject_remix_source_mutation/);
  assert.match(sql, /BEFORE UPDATE OF source_preset_id, source_revision_id/);
  assert.doesNotMatch(sql, /ON DELETE CASCADE/);
  assert.match(sql, /^BEGIN;/m);
  assert.match(sql, /COMMIT;\s*$/);
});
