import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Client, type Pool } from 'pg';
import { createPostgresMarketplaceLikeRepository } from '../server/likes/postgresRepository.ts';
import { createPostgresMarketplaceTrendingRepository } from '../server/trending/postgresRepository.ts';
import { DEFAULT_MARKETPLACE_TRENDING_POLICY } from '../server/trending/policy.ts';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';
import { seedPublishedPreset } from '../server/marketplace/seed.ts';

const connectionString = process.env.MARKETPLACE_TEST_DATABASE_URL;

test('PostgreSQL Trending rebuilds valid active likes into stable separate snapshots', {
  skip: connectionString ? false : 'Set MARKETPLACE_TEST_DATABASE_URL for PostgreSQL Trending integration',
}, async () => {
  const client = new Client({ connectionString });
  const schema = `marketplace_trending_${process.pid}_${Date.now()}`;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    for (const migration of [
      '0001_published_presets.sql', '0002_authentication.sql', '0003_member_profiles.sql',
      '0004_preset_publication.sql', '0005_preset_revision_management.sql',
      '0006_preset_remix_provenance.sql', '0007_preset_collections.sql',
      '0008_preset_search_indexes.sql', '0009_marketplace_likes.sql',
      '0010_marketplace_trending.sql',
    ]) {
      await client.query(await readFile(
        new URL(`../server/marketplace/migrations/${migration}`, import.meta.url), 'utf8',
      ));
    }
    const presetB = {
      ...structuredClone(demoPublishedPreset), id: 'preset-trending-pg-b', title: 'Trending PG B',
      currentRevision: {
        ...structuredClone(demoPublishedPreset.currentRevision), id: 'revision-trending-pg-b',
      },
    };
    await client.query('BEGIN');
    await seedPublishedPreset(client, demoPublishedPreset);
    await seedPublishedPreset(client, presetB);
    for (const [id, handle] of [
      ['member-ada', 'ada'], ['member-bob', 'bob'], ['member-curator', 'curator'],
    ]) {
      await client.query(
        `INSERT INTO marketplace_members (id, handle, display_name) VALUES ($1, $2, $2)`,
        [id, handle],
      );
    }
    await client.query(
      `INSERT INTO marketplace_preset_collections
         (id, creator_id, title, description, visibility)
       VALUES ('collection-trending-pg', 'member-curator', 'Trending PG', '', 'public')`,
    );
    await client.query('COMMIT');

    const poolLike = {
      query: client.query.bind(client),
      async connect() { return { query: client.query.bind(client), release() {} }; },
    } as unknown as Pool;
    const repository = createPostgresMarketplaceLikeRepository(poolLike);
    const trending = createPostgresMarketplaceTrendingRepository(poolLike);
    const now = new Date('2026-08-29T12:00:00.000Z');
    await repository.setLiked({
      kind: 'preset', targetId: demoPublishedPreset.id, memberId: 'member-ada', liked: true,
      now: new Date(now.getTime() - 60 * 60_000),
    });
    await repository.setLiked({
      kind: 'preset', targetId: presetB.id, memberId: 'member-bob', liked: true,
      now: new Date(now.getTime() - 2 * 60 * 60_000),
    });
    await repository.setLiked({
      kind: 'collection', targetId: 'collection-trending-pg', memberId: 'member-ada',
      liked: true, now: new Date(now.getTime() - 90 * 60_000),
    });
    await trending.rebuild({ now, policy: DEFAULT_MARKETPLACE_TRENDING_POLICY });

    const first = await trending.list({ kind: 'preset', limit: 1, cursor: null });
    assert.deepEqual(first.items.map((item) => item.id), [demoPublishedPreset.id]);
    assert.ok(first.nextCursor);
    assert.deepEqual(
      (await trending.list({ kind: 'collection', limit: 20, cursor: null }))
        .items.map((item) => item.id),
      ['collection-trending-pg'],
    );

    await repository.setLiked({
      kind: 'preset', targetId: presetB.id, memberId: 'member-bob', liked: false, now,
    });
    await trending.rebuild({ now, policy: DEFAULT_MARKETPLACE_TRENDING_POLICY });
    assert.deepEqual(
      (await trending.list({
        kind: 'preset', limit: 1, cursor: first.nextCursor,
      })).items.map((item) => item.id),
      [presetB.id],
    );
    assert.deepEqual(
      (await trending.list({ kind: 'preset', limit: 20, cursor: null }))
        .items.map((item) => item.id),
      [demoPublishedPreset.id],
    );

    await client.query(
      `UPDATE marketplace_members SET community_status = 'banned' WHERE id = 'member-ada'`,
    );
    await trending.rebuild({ now, policy: DEFAULT_MARKETPLACE_TRENDING_POLICY });
    assert.deepEqual(
      (await trending.list({ kind: 'preset', limit: 20, cursor: null })).items,
      [],
    );
    assert.deepEqual(
      (await trending.list({ kind: 'collection', limit: 20, cursor: null })).items,
      [],
    );
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
});
