import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Client, Pool, type QueryResultRow } from 'pg';
import { createPostgresPresetCollectionManagementRepository } from '../server/collections/postgresRepository.ts';
import { PresetCollectionTagError } from '../server/collections/repository.ts';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';
import { createPostgresPublishedPresetPublicationRepository } from '../server/marketplace/postgresRepository.ts';
import { UnavailableTagError } from '../server/marketplace/repository.ts';
import { seedPublishedPreset } from '../server/marketplace/seed.ts';
import { createPostgresPublishedPresetSearchRepository } from '../server/search/postgresRepository.ts';
import { createPostgresMarketplaceDiscoveryRepository } from '../server/search/postgresDiscoveryRepository.ts';
import { rebuildMarketplaceTextSearchProjection } from '../server/search/postgresTextProjection.ts';
import type { PublishedPresetSearchInput } from '../server/search/repository.ts';
import { createPostgresMarketplaceTagAdministrationRepository } from '../server/tags/postgresRepository.ts';
import { createPostgresMarketplaceModerationRepository } from '../server/moderation/postgresRepository.ts';
import { DEFAULT_MARKETPLACE_TRENDING_POLICY } from '../server/trending/policy.ts';

const connectionString = process.env.MARKETPLACE_TEST_DATABASE_URL;
const search = (tagIds: string[], text = ''): PublishedPresetSearchInput => ({
  text, tagIds, pedalIds: [], ampIds: [], cabIds: [], resourceKinds: [],
  resourceDependencyKeys: [], publishedAfter: null, publishedBefore: null, limit: 20, cursor: null,
});

interface PromiseOutcome {
  status: 'fulfilled' | 'rejected';
  reason?: unknown;
}

function observe(promise: Promise<unknown>, onSettled?: () => void): Promise<PromiseOutcome> {
  return promise.then(
    () => {
      onSettled?.();
      return { status: 'fulfilled' };
    },
    (reason: unknown) => {
      onSettled?.();
      return { status: 'rejected', reason };
    },
  );
}

function poolPausedAfterOwnedRowLock(pool: Pool, relation: string): {
  pool: Pool;
  reached: Promise<void>;
  resume(): void;
} {
  let markReached: () => void = () => undefined;
  let resume: () => void = () => undefined;
  let paused = false;
  const reached = new Promise<void>((resolve) => { markReached = resolve; });
  const resumed = new Promise<void>((resolve) => { resume = resolve; });
  return {
    pool: {
      query: pool.query.bind(pool),
      async connect() {
        const client = await pool.connect();
        return {
          async query<R extends QueryResultRow>(text: string, values?: readonly unknown[]) {
            const result = await client.query<R>(text, values as unknown[] | undefined);
            if (!paused && text.includes(`FROM ${relation}`) && /FOR (?:UPDATE|NO KEY UPDATE)/.test(text)) {
              paused = true;
              markReached();
              await resumed;
            }
            return result;
          },
          release() { client.release(); },
        };
      },
    } as unknown as Pool,
    reached,
    resume,
  };
}

async function waitForMergeLockOrCompletion(
  admin: Client,
  applicationName: string,
  isSettled: () => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (isSettled()) return;
    const waiting = await admin.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity
         WHERE application_name = $1 AND wait_event_type = 'Lock'
       ) AS waiting`,
      [applicationName],
    );
    if (waiting.rows[0].waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Tag merge ${applicationName} neither completed nor reached its expected lock wait`);
}

async function waitForPause(reached: Promise<void>, label: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      reached,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} did not reach its owned-row lock`)), 2_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function assertMergeWins(
  outcomes: [PromiseOutcome, PromiseOutcome],
  expectedUpdateError: new () => Error,
): void {
  const [update, merge] = outcomes;
  assert.equal(
    merge.status,
    'fulfilled',
    `Tag merge must win the orchestrated race, received: ${String(merge.reason)}`,
  );
  assert.equal(update.status, 'rejected', 'paused update must observe the completed Tag merge');
  assert.ok(
    update.reason instanceof expectedUpdateError,
    `update must reject with ${expectedUpdateError.name}, received: ${String(update.reason)}`,
  );
}

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
      '0015_marketplace_text_search.sql',
      '0016_marketplace_normalized_search.sql',
    ]) {
      await client.query(await readFile(new URL(
        `../server/marketplace/migrations/${migration}`, import.meta.url,
      ), 'utf8'));
    }
    await client.query('BEGIN');
    await seedPublishedPreset(client, demoPublishedPreset);
    await client.query('COMMIT');
    await client.query(
      `UPDATE marketplace_published_presets
       SET title = 'Forwarded preset', description = ''
       WHERE id = $1`,
      [demoPublishedPreset.id],
    );
    await client.query(
      `INSERT INTO marketplace_preset_collections
         (id, creator_id, title, description, visibility, created_at, updated_at)
       VALUES ('collection-tag-forwarding', $1, 'Forwarded collection', '', 'public', $2, $2)`,
      [demoPublishedPreset.creator.id, demoPublishedPreset.createdAt],
    );
    await client.query(
      `INSERT INTO marketplace_preset_collection_tags (collection_id, tag_id)
       VALUES ('collection-tag-forwarding', 'tone-crunch')`,
    );
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
    await client.query(
      `INSERT INTO marketplace_tags (id, dimension, name_zh, name_en, aliases)
       VALUES ('tone-final', 'tone', '最终驱动', 'Final Drive', '[]'::jsonb)`,
    );
    await repository.apply({
      action: 'merge', tagId: 'tone-drive', targetId: 'tone-final',
      auditId: 'audit-chain', actorAuthUserId: 'auth-admin',
      reason: 'Move the consolidated vocabulary again.', now: new Date('2026-08-29T16:02:00Z'),
    });
    await repository.apply({
      action: 'edit', tagId: 'tone-final',
      tag: {
        dimension: 'tone', nameZh: '最终驱动', nameEn: 'Final Drive', aliases: [],
      },
      auditId: 'audit-edit-target', actorAuthUserId: 'auth-admin',
      reason: 'Edit current vocabulary without deleting forwarded search terms.',
      now: new Date('2026-08-29T16:03:00Z'),
    });
    await repository.apply({
      action: 'merge', tagId: 'tone-crunch', targetId: 'tone-drive',
      auditId: 'audit-delayed-retry', actorAuthUserId: 'auth-admin',
      reason: 'Delayed retry after the target was merged again.',
      now: new Date('2026-08-29T16:04:00Z'),
    });
    await rebuildMarketplaceTextSearchProjection(client);

    const managed = await repository.list();
    assert.equal(managed.find((tag) => tag.id === 'tone-crunch')?.mergedIntoId, 'tone-final');
    assert.equal(managed.find((tag) => tag.id === 'tone-final')?.presetCount, 1);
    assert.equal((await repository.listAudit()).filter((entry) => entry.action === 'merge_tag').length, 2);
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
    assert.deepEqual(
      (await createPostgresPublishedPresetSearchRepository(client)
        .searchPublicPresets(search([], 'crunch tone'))).items.map((item) => item.id),
      [demoPublishedPreset.id],
    );
    const discoveryRepository = createPostgresMarketplaceDiscoveryRepository(client);
    const collectionDiscovery = await discoveryRepository.searchPublicCollections({
        text: 'crunch tone', limit: 20, cursor: null,
      });
    assert.deepEqual(
      collectionDiscovery.items.map((item) => item.id),
      ['collection-tag-forwarding'],
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

test('collection Tag writes cannot race a merge and restore the merged source relation', {
  skip: connectionString ? false : 'Set MARKETPLACE_TEST_DATABASE_URL for PostgreSQL Tag administration integration',
}, async () => {
  const admin = new Client({ connectionString });
  const schema = `marketplace_tag_race_${process.pid}_${Date.now()}`;
  const applicationName = `tag_race_${process.pid}_${Date.now()}`;
  const lockKey = 330000 + (process.pid % 10000);
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(`SET search_path TO ${schema}`);
  for (const migration of [
    '0001_published_presets.sql', '0002_authentication.sql', '0003_member_profiles.sql',
    '0004_preset_publication.sql', '0005_preset_revision_management.sql',
    '0006_preset_remix_provenance.sql', '0007_preset_collections.sql',
    '0008_preset_search_indexes.sql', '0009_marketplace_likes.sql',
    '0010_marketplace_trending.sql', '0011_marketplace_moderation.sql',
    '0012_account_lifecycle.sql', '0013_tag_administration.sql',
  ]) {
    await admin.query(await readFile(new URL(
      `../server/marketplace/migrations/${migration}`, import.meta.url,
    ), 'utf8'));
  }
  await admin.query(
    `INSERT INTO marketplace_members (id, handle, display_name, created_at)
     VALUES ('member-curator', 'curator', 'Curator', now())`,
  );
  await admin.query(
    `INSERT INTO marketplace_tags (id, dimension, name_zh, name_en, aliases)
     VALUES ('tone-target', 'tone', '目标', 'Target', '[]'::jsonb)`,
  );
  await admin.query(`SELECT pg_advisory_lock($1)`, [lockKey]);
  await admin.query(`
    CREATE FUNCTION pause_collection_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(${lockKey});
      RETURN NEW;
    END $$;
    CREATE TRIGGER pause_collection_insert
      BEFORE INSERT ON marketplace_preset_collections
      FOR EACH ROW EXECUTE FUNCTION pause_collection_insert();
  `);
  const pool = new Pool({
    connectionString,
    max: 4,
    application_name: applicationName,
    options: `-c search_path=${schema}`,
  });
  try {
    const collections = createPostgresPresetCollectionManagementRepository(pool);
    const tags = createPostgresMarketplaceTagAdministrationRepository(pool);
    const creating = collections.create({
      id: 'collection-race',
      creator: { id: 'member-curator', handle: 'curator', displayName: 'Curator' },
      title: 'Race collection', description: '', tagIds: ['tone-crunch'],
      visibility: 'public', now: new Date('2026-08-29T17:00:00.000Z'),
    });

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const waiting = await admin.query<{ waiting: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity
           WHERE application_name = $1 AND wait_event = 'advisory'
         ) AS waiting`,
        [applicationName],
      );
      if (waiting.rows[0].waiting) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (attempt === 99) assert.fail('collection write did not reach the deterministic pause');
    }

    const merging = tags.apply({
      action: 'merge', tagId: 'tone-crunch', targetId: 'tone-target',
      auditId: 'audit-race', actorAuthUserId: 'auth-admin', reason: 'Race regression.',
      now: new Date('2026-08-29T17:00:01.000Z'),
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await admin.query(`SELECT pg_advisory_unlock($1)`, [lockKey]);
    await Promise.all([creating, merging]);

    const relations = await admin.query<{ tag_id: string }>(
      `SELECT tag_id FROM marketplace_preset_collection_tags
       WHERE collection_id = 'collection-race' ORDER BY tag_id`,
    );
    assert.deepEqual(relations.rows.map((row) => row.tag_id), ['tone-target']);
  } finally {
    await admin.query(`SELECT pg_advisory_unlock($1)`, [lockKey]);
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

test('content Tag updates do not deadlock with a concurrent Tag merge', {
  skip: connectionString ? false : 'Set MARKETPLACE_TEST_DATABASE_URL for PostgreSQL Tag administration integration',
}, async () => {
  const admin = new Client({ connectionString });
  const schema = `marketplace_tag_update_race_${process.pid}_${Date.now()}`;
  const suffix = `${process.pid}_${Date.now()}`;
  const pools: Pool[] = [];
  const createPool = (applicationName: string): Pool => {
    const pool = new Pool({
      connectionString,
      max: 2,
      application_name: `${applicationName}_${suffix}`,
      options: `-c search_path=${schema}`,
    });
    pools.push(pool);
    return pool;
  };
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    for (const migration of [
      '0001_published_presets.sql', '0002_authentication.sql', '0003_member_profiles.sql',
      '0004_preset_publication.sql', '0005_preset_revision_management.sql',
      '0006_preset_remix_provenance.sql', '0007_preset_collections.sql',
      '0008_preset_search_indexes.sql', '0009_marketplace_likes.sql',
      '0010_marketplace_trending.sql', '0011_marketplace_moderation.sql',
      '0012_account_lifecycle.sql', '0013_tag_administration.sql',
    ]) {
      await admin.query(await readFile(new URL(
        `../server/marketplace/migrations/${migration}`, import.meta.url,
      ), 'utf8'));
    }
    await admin.query('BEGIN');
    await seedPublishedPreset(admin, demoPublishedPreset);
    await admin.query('COMMIT');
    await admin.query(
      `INSERT INTO marketplace_tags (id, dimension, name_zh, name_en, aliases)
       VALUES
         ('tone-collection-source', 'tone', '合集来源', 'Collection source', '[]'::jsonb),
         ('tone-collection-target', 'tone', '合集目标', 'Collection target', '[]'::jsonb),
         ('tone-preset-source', 'tone', '预设来源', 'Preset source', '[]'::jsonb),
         ('tone-preset-target', 'tone', '预设目标', 'Preset target', '[]'::jsonb)`,
    );
    const collectionUpdatedAt = new Date('2026-08-29T18:00:00.000Z');
    await admin.query(
      `INSERT INTO marketplace_preset_collections
         (id, creator_id, title, description, visibility, created_at, updated_at)
       VALUES ('collection-update-race', $1, 'Race collection', '', 'public', $2, $2)`,
      [demoPublishedPreset.creator.id, collectionUpdatedAt],
    );
    await admin.query(
      `INSERT INTO marketplace_preset_collection_tags (collection_id, tag_id)
       VALUES ('collection-update-race', 'tone-collection-source')`,
    );
    await admin.query(
      `DELETE FROM marketplace_published_preset_tags WHERE preset_id = $1`,
      [demoPublishedPreset.id],
    );
    await admin.query(
      `INSERT INTO marketplace_published_preset_tags (preset_id, tag_id)
       VALUES ($1, 'tone-preset-source')`,
      [demoPublishedPreset.id],
    );

    const collectionUpdatePool = createPool('collection_update');
    const collectionMergeApplication = `collection_merge_${suffix}`;
    const collectionMergePool = createPool('collection_merge');
    const pausedCollection = poolPausedAfterOwnedRowLock(
      collectionUpdatePool,
      'marketplace_preset_collections',
    );
    const updatingCollection = observe(
      createPostgresPresetCollectionManagementRepository(pausedCollection.pool).update({
        collectionId: 'collection-update-race',
        creatorId: demoPublishedPreset.creator.id,
        title: 'Updated while merging',
        description: '',
        tagIds: ['tone-collection-source'],
        visibility: 'public',
        items: [],
        expectedUpdatedAt: collectionUpdatedAt,
        now: new Date('2026-08-29T18:00:01.000Z'),
      }),
    );
    let collectionMergeSettled = false;
    let mergingCollectionTag: Promise<PromiseOutcome> | undefined;
    try {
      await waitForPause(pausedCollection.reached, 'collection update');
      mergingCollectionTag = observe(
        createPostgresMarketplaceTagAdministrationRepository(collectionMergePool).apply({
          action: 'merge',
          tagId: 'tone-collection-source',
          targetId: 'tone-collection-target',
          auditId: 'audit-collection-update-race',
          actorAuthUserId: 'auth-admin',
          reason: 'Collection update lock-order regression.',
          now: new Date('2026-08-29T18:00:02.000Z'),
        }),
        () => { collectionMergeSettled = true; },
      );
      await waitForMergeLockOrCompletion(
        admin,
        collectionMergeApplication,
        () => collectionMergeSettled,
      );
    } finally {
      pausedCollection.resume();
    }
    assert.ok(mergingCollectionTag, 'collection Tag merge must have started');
    assertMergeWins(
      await Promise.all([updatingCollection, mergingCollectionTag]),
      PresetCollectionTagError,
    );
    const collectionTags = await admin.query<{ tag_id: string }>(
      `SELECT tag_id FROM marketplace_preset_collection_tags
       WHERE collection_id = 'collection-update-race' ORDER BY tag_id`,
    );
    assert.deepEqual(collectionTags.rows.map((row) => row.tag_id), ['tone-collection-target']);

    const presetUpdatePool = createPool('preset_update');
    const presetMergeApplication = `preset_merge_${suffix}`;
    const presetMergePool = createPool('preset_merge');
    const pausedPreset = poolPausedAfterOwnedRowLock(
      presetUpdatePool,
      'marketplace_published_presets',
    );
    const updatingPreset = observe(
      createPostgresPublishedPresetPublicationRepository(pausedPreset.pool).updateMetadata({
        presetId: demoPublishedPreset.id,
        creatorId: demoPublishedPreset.creator.id,
        title: 'Updated while merging',
        description: demoPublishedPreset.description,
        tagIds: ['tone-preset-source'],
        expectedUpdatedAt: new Date(demoPublishedPreset.updatedAt),
        now: new Date('2026-08-29T18:01:01.000Z'),
      }),
    );
    let presetMergeSettled = false;
    let mergingPresetTag: Promise<PromiseOutcome> | undefined;
    try {
      await waitForPause(pausedPreset.reached, 'preset update');
      mergingPresetTag = observe(
        createPostgresMarketplaceTagAdministrationRepository(presetMergePool).apply({
          action: 'merge',
          tagId: 'tone-preset-source',
          targetId: 'tone-preset-target',
          auditId: 'audit-preset-update-race',
          actorAuthUserId: 'auth-admin',
          reason: 'Preset update lock-order regression.',
          now: new Date('2026-08-29T18:01:02.000Z'),
        }),
        () => { presetMergeSettled = true; },
      );
      await waitForMergeLockOrCompletion(
        admin,
        presetMergeApplication,
        () => presetMergeSettled,
      );
    } finally {
      pausedPreset.resume();
    }
    assert.ok(mergingPresetTag, 'preset Tag merge must have started');
    assertMergeWins(
      await Promise.all([updatingPreset, mergingPresetTag]),
      UnavailableTagError,
    );
    const presetTags = await admin.query<{ tag_id: string }>(
      `SELECT tag_id FROM marketplace_published_preset_tags
       WHERE preset_id = $1 ORDER BY tag_id`,
      [demoPublishedPreset.id],
    );
    assert.deepEqual(presetTags.rows.map((row) => row.tag_id), ['tone-preset-target']);
  } finally {
    await Promise.all(pools.map((pool) => pool.end()));
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
