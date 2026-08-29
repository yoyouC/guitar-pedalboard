import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Client, type Pool } from 'pg';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';
import { seedPublishedPreset } from '../server/marketplace/seed.ts';
import {
  createPostgresMarketplaceLikeRepository,
  rebuildMarketplaceLikeCounts,
} from '../server/likes/postgresRepository.ts';
import { SelfLikeForbiddenError } from '../server/likes/repository.ts';

const connectionString = process.env.MARKETPLACE_TEST_DATABASE_URL;

test('PostgreSQL likes enforce uniqueness, privacy, two target kinds, and rebuildable Popular counts', {
  skip: connectionString ? false : 'Set MARKETPLACE_TEST_DATABASE_URL for PostgreSQL likes integration',
}, async () => {
  const client = new Client({ connectionString });
  const schema = `marketplace_likes_${process.pid}_${Date.now()}`;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    for (const migration of [
      '0001_published_presets.sql', '0002_authentication.sql', '0003_member_profiles.sql',
      '0004_preset_publication.sql', '0005_preset_revision_management.sql',
      '0006_preset_remix_provenance.sql', '0007_preset_collections.sql',
      '0008_preset_search_indexes.sql', '0009_marketplace_likes.sql',
    ]) {
      await client.query(await readFile(
        new URL(`../server/marketplace/migrations/${migration}`, import.meta.url), 'utf8',
      ));
    }
    const presetB = {
      ...structuredClone(demoPublishedPreset), id: 'preset-like-b', title: 'Like B',
      currentRevision: { ...structuredClone(demoPublishedPreset.currentRevision), id: 'revision-like-b' },
    };
    await client.query('BEGIN');
    await seedPublishedPreset(client, demoPublishedPreset);
    await seedPublishedPreset(client, presetB);
    for (const [id, handle] of [['member-ada', 'ada'], ['member-bob', 'bob'], ['member-curator', 'curator']]) {
      await client.query(
        `INSERT INTO marketplace_members (id, handle, display_name) VALUES ($1, $2, $2)`,
        [id, handle],
      );
    }
    await client.query(
      `INSERT INTO marketplace_preset_collections
         (id, creator_id, title, description, visibility)
       VALUES ('collection-like-a', 'member-curator', 'Collection Like A', '', 'public')`,
    );
    await client.query('COMMIT');

    const poolLike = {
      query: client.query.bind(client),
      async connect() { return { query: client.query.bind(client), release() {} }; },
    } as unknown as Pool;
    const repository = createPostgresMarketplaceLikeRepository(poolLike);
    const now = new Date('2026-08-29T10:00:00.000Z');
    await repository.setLiked({ kind: 'preset', targetId: demoPublishedPreset.id, memberId: 'member-ada', liked: true, now });
    await repository.setLiked({ kind: 'preset', targetId: demoPublishedPreset.id, memberId: 'member-ada', liked: true, now });
    await repository.setLiked({ kind: 'preset', targetId: demoPublishedPreset.id, memberId: 'member-bob', liked: true, now });
    await repository.setLiked({ kind: 'preset', targetId: presetB.id, memberId: 'member-ada', liked: true, now });
    await repository.setLiked({ kind: 'collection', targetId: 'collection-like-a', memberId: 'member-ada', liked: true, now });
    assert.equal((await repository.getState('preset', demoPublishedPreset.id, 'member-ada')).likeCount, 2);
    await assert.rejects(
      repository.setLiked({ kind: 'preset', targetId: demoPublishedPreset.id, memberId: demoPublishedPreset.creator.id, liked: true, now }),
      SelfLikeForbiddenError,
    );
    assert.deepEqual((await repository.listMine('member-ada')).presets.map((item) => item.id), [
      presetB.id, demoPublishedPreset.id,
    ]);
    const firstPopular = await repository.listPopular({ kind: 'preset', limit: 1, cursor: null });
    assert.deepEqual(firstPopular.items.map((item) => item.likeCount), [2]);
    assert.ok(firstPopular.nextCursor);
    await repository.setLiked({ kind: 'preset', targetId: demoPublishedPreset.id, memberId: 'member-bob', liked: false, now });
    await repository.setLiked({ kind: 'preset', targetId: presetB.id, memberId: 'member-bob', liked: true, now });
    assert.deepEqual(
      (await repository.listPopular({
        kind: 'preset', limit: 1, cursor: firstPopular.nextCursor,
      })).items.map((item) => [item.id, item.likeCount]),
      [[presetB.id, 1]],
    );
    await repository.setLiked({ kind: 'preset', targetId: presetB.id, memberId: 'member-bob', liked: false, now });
    await repository.setLiked({ kind: 'preset', targetId: demoPublishedPreset.id, memberId: 'member-bob', liked: true, now });
    assert.deepEqual((await repository.listPopular({ kind: 'collection', limit: 20, cursor: null })).items.map((item) => item.id), ['collection-like-a']);

    await client.query('DELETE FROM marketplace_preset_like_counts');
    await client.query('DELETE FROM marketplace_collection_like_counts');
    await rebuildMarketplaceLikeCounts(poolLike, new Date('2026-08-29T11:00:00.000Z'));
    assert.equal((await repository.getState('preset', demoPublishedPreset.id, null)).likeCount, 2);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
});
