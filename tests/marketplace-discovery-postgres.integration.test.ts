import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Client } from 'pg';
import { createPostgresMarketplaceDiscoveryRepository } from '../server/search/postgresDiscoveryRepository.ts';

const connectionString = process.env.MARKETPLACE_TEST_DATABASE_URL;
const migrations = [
  '0001_published_presets.sql',
  '0002_authentication.sql',
  '0003_member_profiles.sql',
  '0004_preset_publication.sql',
  '0005_preset_revision_management.sql',
  '0006_preset_remix_provenance.sql',
  '0007_preset_collections.sql',
  '0008_preset_search_indexes.sql',
  '0009_marketplace_likes.sql',
  '0010_marketplace_trending.sql',
  '0011_marketplace_moderation.sql',
  '0012_account_lifecycle.sql',
];

test('PostgreSQL discovery keeps collection and creator tabs private and cursor-stable', {
  skip: connectionString ? false : 'Set MARKETPLACE_TEST_DATABASE_URL for discovery integration',
}, async () => {
  const client = new Client({ connectionString });
  const schema = `marketplace_discovery_${process.pid}_${Date.now()}`;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    for (const migration of migrations) {
      await client.query(await readFile(
        new URL(`../server/marketplace/migrations/${migration}`, import.meta.url),
        'utf8',
      ));
    }
    await client.query(
      `INSERT INTO marketplace_members
         (id, handle, display_name, bio, created_at, updated_at)
       VALUES
         ('member-ada', 'ada-tones', 'Ada Lovelace', 'Analytical guitar tones',
          '2026-08-29T07:00:00.000Z', '2026-08-29T07:00:00.000Z'),
         ('member-grace', 'grace-rigs', 'Grace Hopper', 'Compiler and chorus tones',
          '2026-08-29T06:00:00.000Z', '2026-08-29T06:00:00.000Z')`,
    );
    await client.query(
      `INSERT INTO marketplace_preset_collections
         (id, creator_id, title, description, visibility, created_at, updated_at)
       VALUES
         ('collection-3', 'member-ada', 'Rock Stage Three', 'Modern stage tones', 'public',
          '2026-08-29T10:00:00.000Z', '2026-08-29T10:00:00.000Z'),
         ('collection-2', 'member-grace', 'Rock Stage Two', 'Classic stage tones', 'public',
          '2026-08-29T09:00:00.000Z', '2026-08-29T09:00:00.000Z'),
         ('collection-1', 'member-ada', 'Rock Stage One', 'Small stage tones', 'public',
          '2026-08-29T08:00:00.000Z', '2026-08-29T08:00:00.000Z'),
         ('collection-secret', 'member-ada', 'Secret Search Leak', 'Never discover this', 'unlisted',
          '2026-08-29T11:00:00.000Z', '2026-08-29T11:00:00.000Z')`,
    );
    await client.query(
      `INSERT INTO marketplace_preset_collection_tags (collection_id, tag_id)
       VALUES ('collection-3', 'genre-rock'), ('collection-2', 'genre-rock'),
              ('collection-1', 'genre-rock'), ('collection-secret', 'genre-rock')`,
    );
    await client.query(
      `UPDATE marketplace_tags SET aliases = '["arena-code"]'::jsonb WHERE id = 'genre-rock'`,
    );

    const repository = createPostgresMarketplaceDiscoveryRepository(client);
    const first = await repository.searchPublicCollections({
      text: 'rock', limit: 2, cursor: null,
    });
    assert.deepEqual(first.items.map((item) => item.id), ['collection-3', 'collection-2']);
    assert.equal(typeof first.nextCursor, 'string');

    await client.query(
      `INSERT INTO marketplace_preset_collections
         (id, creator_id, title, description, visibility, created_at, updated_at)
       VALUES ('collection-new', 'member-ada', 'Rock New', '', 'public',
               '2026-08-29T12:00:00.000Z', '2026-08-29T12:00:00.000Z')`,
    );
    const second = await repository.searchPublicCollections({
      text: 'rock', limit: 2, cursor: first.nextCursor,
    });
    assert.deepEqual(second.items.map((item) => item.id), ['collection-1']);
    assert.equal(JSON.stringify([...first.items, ...second.items]).includes('collection-secret'), false);
    assert.deepEqual(
      (await repository.searchPublicCollections({
        text: 'arena-code', limit: 20, cursor: null,
      })).items.map((item) => item.id),
      ['collection-3', 'collection-2', 'collection-1'],
    );
    assert.deepEqual(
      (await repository.searchPublicCollections({
        text: 'hopper', limit: 20, cursor: null,
      })).items.map((item) => item.id),
      ['collection-2'],
    );

    const creators = await repository.searchCreators({ text: 'lovel', limit: 20, cursor: null });
    assert.deepEqual(creators.items.map((item) => ({ id: item.id, url: item.url })), [{
      id: 'member-ada', url: '/creators/id/member-ada',
    }]);
    assert.equal(JSON.stringify(creators).includes('auth'), false);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
});
