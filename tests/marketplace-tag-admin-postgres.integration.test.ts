import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Client, type Pool } from 'pg';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';
import { createPostgresPublishedPresetPublicationRepository } from '../server/marketplace/postgresRepository.ts';
import { seedPublishedPreset } from '../server/marketplace/seed.ts';
import { createPostgresPublishedPresetSearchRepository } from '../server/search/postgresRepository.ts';
import type { PublishedPresetSearchInput } from '../server/search/repository.ts';
import { createPostgresMarketplaceTagAdministrationRepository } from '../server/tags/postgresRepository.ts';
import { createPostgresMarketplaceModerationRepository } from '../server/moderation/postgresRepository.ts';
import { DEFAULT_MARKETPLACE_TRENDING_POLICY } from '../server/trending/policy.ts';

const connectionString = process.env.MARKETPLACE_TEST_DATABASE_URL;
const search = (tagIds: string[]): PublishedPresetSearchInput => ({
  text: '', tagIds, pedalIds: [], ampIds: [], cabIds: [], resourceKinds: [],
  resourceDependencyKeys: [], publishedAfter: null, publishedBefore: null, limit: 20, cursor: null,
});

test('PostgreSQL Tag merge atomically migrates content and keeps old search ids compatible', {
  skip: connectionString ? false : 'Set MARKETPLACE_TEST_DATABASE_URL for PostgreSQL Tag administration integration',
}, async () => {
  const client = new Client({ connectionString });
  const schema = `marketplace_tags_${process.pid}_${Date.now()}`;
  await client.connect();
  const poolLike = {
    query: client.query.bind(client),
    async connect() { return { query: client.query.bind(client), release() {} }; },
  } as unknown as Pool;
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    for (const migration of [
      '0001_published_presets.sql', '0002_authentication.sql', '0003_member_profiles.sql',
      '0004_preset_publication.sql', '0005_preset_revision_management.sql',
      '0006_preset_remix_provenance.sql', '0007_preset_collections.sql',
      '0008_preset_search_indexes.sql', '0009_marketplace_likes.sql',
      '0010_marketplace_trending.sql', '0011_marketplace_moderation.sql',
      '0012_account_lifecycle.sql',
      '0013_tag_administration.sql',
    ]) {
      await client.query(await readFile(new URL(
        `../server/marketplace/migrations/${migration}`, import.meta.url,
      ), 'utf8'));
    }
    await client.query('BEGIN');
    await seedPublishedPreset(client, demoPublishedPreset);
    await client.query('COMMIT');
    await client.query(
      `INSERT INTO marketplace_tags (id, dimension, name_zh, name_en, aliases)
       VALUES ('tone-drive', 'tone', '驱动', 'Drive', '["drive"]'::jsonb)`,
    );
    const repository = createPostgresMarketplaceTagAdministrationRepository(poolLike);
    await repository.apply({
      action: 'merge', tagId: 'tone-crunch', targetId: 'tone-drive',
      auditId: 'audit-merge', actorAuthUserId: 'auth-admin',
      reason: 'Consolidate equivalent drive vocabulary.', now: new Date('2026-08-29T16:00:00Z'),
    });
    await repository.apply({
      action: 'merge', tagId: 'tone-crunch', targetId: 'tone-drive',
      auditId: 'audit-retry', actorAuthUserId: 'auth-admin',
      reason: 'Safe retry.', now: new Date('2026-08-29T16:01:00Z'),
    });

    const managed = await repository.list();
    assert.equal(managed.find((tag) => tag.id === 'tone-crunch')?.mergedIntoId, 'tone-drive');
    assert.equal(managed.find((tag) => tag.id === 'tone-drive')?.presetCount, 1);
    assert.equal((await repository.listAudit()).filter((entry) => entry.action === 'merge_tag').length, 1);
    assert.equal(
      (await createPostgresMarketplaceModerationRepository(
        poolLike,
        DEFAULT_MARKETPLACE_TRENDING_POLICY,
      ).listAudit()).some((entry) => entry.action === 'merge_tag' && entry.subjectKind === 'tag'),
      true,
    );
    assert.deepEqual(
      (await createPostgresPublishedPresetSearchRepository(client)
        .searchPublicPresets(search(['tone-crunch']))).items.map((item) => item.id),
      [demoPublishedPreset.id],
    );
    assert.equal(
      (await createPostgresPublishedPresetPublicationRepository(poolLike).listAvailableTags())
        .some((tag) => tag.id === 'tone-crunch'),
      false,
    );
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
});
