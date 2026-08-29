import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Client } from 'pg';

const connectionString = process.env.MARKETPLACE_TEST_DATABASE_URL;

test('0005 backfills immutable revisions and 0006 pins Remix source pairs', {
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

    await client.query(await readFile(
      new URL('../server/marketplace/migrations/0006_preset_remix_provenance.sql', import.meta.url),
      'utf8',
    ));
    await client.query(
      `INSERT INTO marketplace_members (id, handle, display_name)
       VALUES ('member-remix', 'migration-remix', 'Migration Remix')`,
    );
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO marketplace_published_presets
         (id, creator_id, title, visibility, current_revision_id,
          source_preset_id, source_revision_id)
       VALUES ('preset-remix', 'member-remix', 'Pinned Remix', 'public',
               'revision-remix', 'preset-test', 'revision-test')`,
    );
    await client.query(
      `INSERT INTO marketplace_published_preset_revisions
         (id, preset_id, schema_version, resource_dependencies, derived_attributes, rig)
       SELECT 'revision-remix', 'preset-remix', schema_version,
              resource_dependencies, derived_attributes, rig
       FROM marketplace_published_preset_revisions
       WHERE id = 'revision-test'`,
    );
    await client.query('COMMIT');
    await client.query(
      `UPDATE marketplace_published_presets SET visibility = 'withdrawn'
       WHERE id = 'preset-test'`,
    );
    const remix = await client.query<{
      source_preset_id: string;
      source_revision_id: string;
      source_visibility: string;
    }>(
      `SELECT remix.source_preset_id, remix.source_revision_id,
              source.visibility AS source_visibility
       FROM marketplace_published_presets AS remix
       JOIN marketplace_published_presets AS source ON source.id = remix.source_preset_id
       WHERE remix.id = 'preset-remix'`,
    );
    assert.deepEqual(remix.rows[0], {
      source_preset_id: 'preset-test',
      source_revision_id: 'revision-test',
      source_visibility: 'withdrawn',
    });
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO marketplace_published_presets
         (id, creator_id, title, visibility, current_revision_id)
       VALUES ('preset-second-source', 'member-test', 'Second Source', 'public',
               'revision-second-source')`,
    );
    await client.query(
      `INSERT INTO marketplace_published_preset_revisions
         (id, preset_id, schema_version, resource_dependencies, derived_attributes, rig)
       SELECT 'revision-second-source', 'preset-second-source', schema_version,
              resource_dependencies, derived_attributes, rig
       FROM marketplace_published_preset_revisions
       WHERE id = 'revision-test'`,
    );
    await client.query('COMMIT');
    await assert.rejects(
      () => client.query(
        `UPDATE marketplace_published_presets
         SET source_preset_id = 'preset-second-source',
             source_revision_id = 'revision-second-source'
         WHERE id = 'preset-remix'`,
      ),
      /Remix provenance is immutable/,
    );
    await assert.rejects(
      () => client.query(
        `UPDATE marketplace_published_presets
         SET source_preset_id = NULL, source_revision_id = NULL
         WHERE id = 'preset-remix'`,
      ),
      /Remix provenance is immutable/,
    );
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
});

test('0016 upgrades legacy trigram indexes to application-normalized projections', {
  skip: connectionString ? false : 'Set MARKETPLACE_TEST_DATABASE_URL for PostgreSQL migration integration',
}, async () => {
  const client = new Client({ connectionString });
  const schema = `marketplace_search_migration_${process.pid}_${Date.now()}`;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    for (const migration of [
      '0001_published_presets.sql', '0002_authentication.sql', '0003_member_profiles.sql',
      '0004_preset_publication.sql', '0005_preset_revision_management.sql',
      '0006_preset_remix_provenance.sql', '0007_preset_collections.sql',
      '0015_marketplace_text_search.sql', '0016_marketplace_normalized_search.sql',
    ]) {
      await client.query(await readFile(new URL(
        `../server/marketplace/migrations/${migration}`, import.meta.url,
      ), 'utf8'));
    }
    const columns = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = $1 AND column_name = 'search_text' ORDER BY table_name`,
      [schema],
    );
    assert.deepEqual(columns.rows.map((row) => row.table_name), [
      'marketplace_members', 'marketplace_preset_collections',
      'marketplace_published_presets', 'marketplace_tags',
    ]);
    const indexes = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = $1 AND indexname LIKE 'marketplace_%_search_text_trgm_idx'`,
      [schema],
    );
    assert.equal(indexes.rowCount, 4);
    assert.equal(indexes.rows.every((row) => (
      row.indexdef.includes('search_text') && row.indexdef.includes('gin_trgm_ops')
    )), true);
    await assert.doesNotReject(async () => {
      await client.query(await readFile(
        new URL('../server/marketplace/migrations/0016_marketplace_normalized_search.sql', import.meta.url),
        'utf8',
      ));
    });
    await client.query(
      `INSERT INTO marketplace_members (id, handle, display_name, search_text)
       VALUES ('member-projection-protocol', 'projection-protocol', 'ROCK',
               'projection protocol rock')`,
    );
    await client.query('BEGIN');
    await client.query(`SELECT set_config('marketplace.search_projection_write', 'on', true)`);
    await client.query(
      `UPDATE marketplace_members
       SET display_name = 'ＲＯＣＫ', search_text = 'projection protocol rock'
       WHERE id = 'member-projection-protocol'`,
    );
    await client.query('COMMIT');
    assert.equal((await client.query<{ search_text: string | null }>(
      `SELECT search_text FROM marketplace_members WHERE id = 'member-projection-protocol'`,
    )).rows[0].search_text, 'projection protocol rock');
    await client.query(
      `UPDATE marketplace_members SET display_name = 'Rock!' WHERE id = 'member-projection-protocol'`,
    );
    assert.equal((await client.query<{ search_text: string | null }>(
      `SELECT search_text FROM marketplace_members WHERE id = 'member-projection-protocol'`,
    )).rows[0].search_text, null);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
});
