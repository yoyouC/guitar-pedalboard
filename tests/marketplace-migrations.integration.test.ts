import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Client } from 'pg';

const connectionString = process.env.MARKETPLACE_TEST_DATABASE_URL;

test('0005 backfills an existing immutable revision and restores its trigger', {
  skip: connectionString ? false : 'Set MARKETPLACE_TEST_DATABASE_URL for PostgreSQL migration integration',
}, async () => {
  const client = new Client({ connectionString });
  const schema = `marketplace_migration_${process.pid}_${Date.now()}`;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    for (const migration of ['0001_published_presets.sql', '0004_preset_publication.sql']) {
      await client.query(await readFile(
        new URL(`../server/marketplace/migrations/${migration}`, import.meta.url),
        'utf8',
      ));
    }
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO marketplace_members (id, handle, display_name)
       VALUES ('member-test', 'migration-test', 'Migration Test')`,
    );
    await client.query(
      `INSERT INTO marketplace_published_presets
         (id, creator_id, title, visibility, current_revision_id)
       VALUES ('preset-test', 'member-test', 'Before 0005', 'public', 'revision-test')`,
    );
    await client.query(
      `INSERT INTO marketplace_published_preset_revisions
         (id, preset_id, schema_version, resource_dependencies, rig)
       VALUES ('revision-test', 'preset-test', 5, '[{"kind":"builtin"}]', '{}')`,
    );
    await client.query(
      `INSERT INTO marketplace_published_preset_search_projection
         (preset_id, pedal_ids, amp_id, amp_model_key, cab_id, resource_kinds, projected_at)
       VALUES ('preset-test', ARRAY['retired-pedal'], 'retired-amp',
               'builtin:retired', 'retired-cab', ARRAY['builtin'], now())`,
    );
    await client.query('COMMIT');

    await client.query(await readFile(
      new URL('../server/marketplace/migrations/0005_preset_revision_management.sql', import.meta.url),
      'utf8',
    ));
    const result = await client.query<{ derived_attributes: Record<string, unknown> }>(
      `SELECT derived_attributes FROM marketplace_published_preset_revisions
       WHERE id = 'revision-test'`,
    );
    assert.deepEqual(result.rows[0].derived_attributes, {
      pedalIds: ['retired-pedal'],
      ampId: 'retired-amp',
      ampModelKey: 'builtin:retired',
      cabId: 'retired-cab',
      resourceKinds: ['builtin'],
    });
    await assert.rejects(
      () => client.query(
        `UPDATE marketplace_published_preset_revisions
         SET rig = '{"mutated":true}' WHERE id = 'revision-test'`,
      ),
      /append-only/,
    );
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
});
