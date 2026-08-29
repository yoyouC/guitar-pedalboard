import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Client, Pool } from 'pg';
import { createMarketplaceAccountApi } from '../server/accounts/api.ts';
import { createPostgresMarketplaceAccountRepository } from '../server/accounts/postgresRepository.ts';
import { createPlatformAuth } from '../server/auth/betterAuth.ts';
import { createBetterAuthSessionVerifier } from '../server/auth/betterAuthSession.ts';
import { createPostgresPresetCollectionRepository } from '../server/collections/postgresRepository.ts';
import { createPresetCollectionApi } from '../server/collections/api.ts';
import { createMarketplaceLikesApi } from '../server/likes/api.ts';
import {
  createPostgresMarketplaceLikeRepository,
  rebuildMarketplaceLikeCounts,
} from '../server/likes/postgresRepository.ts';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';
import { createMarketplaceApi } from '../server/marketplace/api.ts';
import {
  createPostgresPublishedPresetPublicationRepository,
  createPostgresPublishedPresetRepository,
} from '../server/marketplace/postgresRepository.ts';
import { seedPublishedPreset } from '../server/marketplace/seed.ts';
import { createMemberApi } from '../server/members/api.ts';
import { createPostgresMemberRepository } from '../server/members/postgresRepository.ts';
import { createMarketplaceModerationApi } from '../server/moderation/api.ts';
import { createPostgresMarketplaceModerationRepository } from '../server/moderation/postgresRepository.ts';
import { DEFAULT_MARKETPLACE_TRENDING_POLICY } from '../server/trending/policy.ts';
import { createPostgresMarketplaceTrendingRepository } from '../server/trending/postgresRepository.ts';

const connectionString = process.env.MARKETPLACE_TEST_DATABASE_URL;
const migrations = [
  '0001_published_presets.sql', '0002_authentication.sql', '0003_member_profiles.sql',
  '0004_preset_publication.sql', '0005_preset_revision_management.sql',
  '0006_preset_remix_provenance.sql', '0007_preset_collections.sql',
  '0008_preset_search_indexes.sql', '0009_marketplace_likes.sql',
  '0010_marketplace_trending.sql', '0011_marketplace_moderation.sql',
  '0012_account_lifecycle.sql',
];

test('PostgreSQL account export, recovery, purge, and tombstones preserve only required facts', {
  skip: connectionString ? false : 'Set MARKETPLACE_TEST_DATABASE_URL for account lifecycle integration',
}, async () => {
  const client = new Client({ connectionString });
  const schema = `marketplace_account_${process.pid}_${Date.now()}`;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    for (const migration of migrations) {
      await client.query(await readFile(
        new URL(`../server/marketplace/migrations/${migration}`, import.meta.url), 'utf8',
      ));
    }
    await client.query('BEGIN');
    await seedPublishedPreset(client, demoPublishedPreset);
    await client.query('COMMIT');
    const ownerId = demoPublishedPreset.creator.id;
    const ownerAuthId = 'auth-owner';
    const otherId = 'member-other';
    await client.query(
      `INSERT INTO marketplace_auth_users
         (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES
         ($1, 'Owner Secret Name', 'owner@example.test', true, $2, $2),
         ('auth-other', 'Other Member', 'other-private@example.test', true, $2, $2)`,
      [ownerAuthId, new Date('2026-08-01T00:00:00.000Z')],
    );
    await client.query(
      `INSERT INTO marketplace_members
         (id, handle, display_name, bio, created_at, updated_at)
       VALUES ($1, 'other-rigs', 'Other Member', '', $2, $2)`,
      [otherId, new Date('2026-08-01T00:00:00.000Z')],
    );
    await client.query(
      `INSERT INTO marketplace_member_handle_claims (handle, member_id)
       VALUES ('guitar-pedalboard', $1), ('other-rigs', $2)
       ON CONFLICT (handle) DO NOTHING`,
      [ownerId, otherId],
    );
    await client.query(
      `INSERT INTO marketplace_member_auth_identities (auth_user_id, member_id)
       VALUES ($1, $2), ('auth-other', $3)`,
      [ownerAuthId, ownerId, otherId],
    );
    await client.query(
      `INSERT INTO marketplace_auth_sessions
         (id, "expiresAt", token, "createdAt", "updatedAt", "userId")
       VALUES ('session-owner', $2, 'owner-session-secret', $1, $1, $3)`,
      [new Date('2026-08-29T00:00:00.000Z'), new Date('2026-09-29T00:00:00.000Z'), ownerAuthId],
    );
    await client.query(
      `INSERT INTO marketplace_auth_verifications
         (id, identifier, value, "expiresAt", "createdAt", "updatedAt")
       VALUES ('verification-owner', 'hashed-magic-token',
               '{"email":"owner@example.test"}', $2, $1, $1)`,
      [new Date('2026-08-29T00:00:00.000Z'), new Date('2026-08-29T00:05:00.000Z')],
    );

    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await client.query(
      `INSERT INTO marketplace_published_presets
         (id, creator_id, title, description, visibility, current_revision_id,
          source_preset_id, source_revision_id, created_at, updated_at)
       VALUES
         ('preset-remix', $1, 'Other Remix', 'Must remain after source purge', 'public',
          'revision-remix-1', $2, $3, $4, $4)`,
      [otherId, demoPublishedPreset.id, demoPublishedPreset.currentRevision.id,
        new Date('2026-08-20T00:00:00.000Z')],
    );
    await client.query(
      `INSERT INTO marketplace_published_preset_revisions
         (id, preset_id, schema_version, resource_dependencies, derived_attributes, rig, created_at)
       SELECT 'revision-remix-1', 'preset-remix', schema_version,
              resource_dependencies, derived_attributes, rig, $2
       FROM marketplace_published_preset_revisions WHERE id = $1`,
      [demoPublishedPreset.currentRevision.id, new Date('2026-08-20T00:00:00.000Z')],
    );
    await client.query(
      `INSERT INTO marketplace_published_preset_tags (preset_id, tag_id)
       VALUES ('preset-remix', 'genre-rock')`,
    );
    await client.query(
      `INSERT INTO marketplace_published_preset_search_projection
         (preset_id, pedal_ids, amp_id, amp_model_key, cab_id, resource_kinds,
          resource_dependency_keys, projected_at)
       SELECT 'preset-remix', pedal_ids, amp_id, amp_model_key, cab_id, resource_kinds,
              resource_dependency_keys, $2
       FROM marketplace_published_preset_search_projection WHERE preset_id = $1`,
      [demoPublishedPreset.id, new Date('2026-08-20T00:00:00.000Z')],
    );
    await client.query('COMMIT');

    await client.query(
      `INSERT INTO marketplace_preset_collections
         (id, creator_id, title, description, visibility, created_at, updated_at)
       VALUES
         ('collection-owner', $1, 'Owner Private Set', 'Owner collection body', 'public', $3, $3),
         ('collection-owner-hidden', $1, 'Moderated Set', '', 'hidden', $3, $3),
         ('collection-owner-withdrawn', $1, 'Already Withdrawn', '', 'withdrawn', $3, $3),
         ('collection-other', $2, 'Other Set', 'Must keep a source placeholder', 'public', $3, $3)`,
      [ownerId, otherId, new Date('2026-08-21T00:00:00.000Z')],
    );
    await client.query(
      `INSERT INTO marketplace_preset_collection_tags (collection_id, tag_id)
       VALUES ('collection-owner', 'genre-rock'), ('collection-other', 'genre-rock')`,
    );
    await client.query(
      `INSERT INTO marketplace_preset_collection_items
         (collection_id, position, preset_id, revision_id)
       VALUES
         ('collection-owner', 0, 'preset-remix', 'revision-remix-1'),
         ('collection-other', 0, $1, $2)`,
      [demoPublishedPreset.id, demoPublishedPreset.currentRevision.id],
    );
    await client.query(
      `INSERT INTO marketplace_preset_likes (member_id, preset_id, created_at)
       VALUES ($1, 'preset-remix', $3), ($2, $4, $3)`,
      [ownerId, otherId, new Date('2026-08-25T00:00:00.000Z'), demoPublishedPreset.id],
    );
    await client.query(
      `INSERT INTO marketplace_collection_likes (member_id, collection_id, created_at)
       VALUES ($1, 'collection-other', $2)`,
      [ownerId, new Date('2026-08-25T00:00:00.000Z')],
    );
    await client.query(
      `INSERT INTO marketplace_moderation_reports
         (id, reporter_member_id, target_kind, target_id, reason, details, created_at)
       VALUES ('report-owner', $1, 'preset', 'preset-remix', 'spam',
               'Owner report retained for audit', $2)`,
      [ownerId, new Date('2026-08-26T00:00:00.000Z')],
    );
    await client.query(
      `INSERT INTO marketplace_moderation_actions
         (id, actor_auth_user_id, action, subject_kind, subject_id, reason,
          previous_visibility, created_at)
       VALUES ('action-owner-hidden', 'auth-admin', 'hide', 'collection',
               'collection-owner-hidden', 'Fixture moderation hide', 'public', $1)`,
      [new Date('2026-08-27T00:00:00.000Z')],
    );
    await client.query(
      `INSERT INTO marketplace_moderation_appeals
         (id, action_id, author_member_id, statement, created_at)
       VALUES ('appeal-owner-hidden', 'action-owner-hidden', $1,
               'Fixture appeal', $2)`,
      [ownerId, new Date('2026-08-28T00:00:00.000Z')],
    );

    const poolLike = {
      query: client.query.bind(client),
      async connect() { return { query: client.query.bind(client), release() {} }; },
    } as unknown as Pool;
    const repository = createPostgresMarketplaceAccountRepository(poolLike);
    const databaseNow = new Date((await client.query<{ now: Date }>(
      'SELECT clock_timestamp() AS now',
    )).rows[0].now);
    let currentTime = databaseNow;
    await rebuildMarketplaceLikeCounts(poolLike, currentTime);
    const likes = createPostgresMarketplaceLikeRepository(poolLike);
    assert.equal(
      (await likes.listPopular({ kind: 'preset', limit: 20, cursor: null }))
        .items.some((item) => item.id === 'preset-remix'),
      true,
    );
    const deliveredLinks: string[] = [];
    const auth = createPlatformAuth({
      baseURL: 'https://pedalboard.test',
      secret: 'account-lifecycle-test-secret-at-least-32-characters',
      database: poolLike,
      sendMagicLink: async ({ url }) => { deliveredLinks.push(url); },
    });
    const requestMagicLink = async (email: string, name: string): Promise<string> => {
      const requestedLink = await auth.handler(new Request(
        'https://pedalboard.test/api/auth/sign-in/magic-link', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'https://pedalboard.test' },
          body: JSON.stringify({
            email, name, callbackURL: '/',
          }),
        },
      ));
      assert.equal(requestedLink.status, 200);
      return deliveredLinks.at(-1)!;
    };
    const verifyMagicLink = async (url: string): Promise<string | null> => {
      const verification = await auth.handler(new Request(url, {
        headers: { origin: 'https://pedalboard.test' }, redirect: 'manual',
      }));
      return verification.headers.get('set-cookie');
    };
    const signIn = async (email: string, name: string): Promise<string> => {
      const cookie = await verifyMagicLink(await requestMagicLink(email, name));
      assert.ok(cookie);
      return cookie;
    };
    let ownerCookie = await signIn('owner@example.test', 'Owner Secret Name');
    const sessions = createBetterAuthSessionVerifier(auth.api);
    const api = createMarketplaceAccountApi({
      repository, sessions, now: () => currentTime, cronSecret: 'cron-secret',
    });
    const accountRequest = (method: string, path = '/api/marketplace/me/deletion') => api.fetch(
      new Request(`https://pedalboard.test${path}`, {
        method, headers: { cookie: ownerCookie },
      }),
    );
    const members = createPostgresMemberRepository(poolLike);
    const publicPresets = createPostgresPublishedPresetRepository(client);
    const publication = createPostgresPublishedPresetPublicationRepository(poolLike);
    const presetApi = createMarketplaceApi({
      publishedPresets: publicPresets,
      publication: {
        repository: publication,
        sessions,
        members,
        now: () => currentTime,
        createPresetId: () => 'preset-must-not-be-created',
        createRevisionId: () => 'revision-must-not-be-created',
        createMemberId: () => 'member-must-not-be-created',
        createHandleSuffix: () => 'blocked1',
      },
    });
    const collectionApi = createPresetCollectionApi({
      collections: createPostgresPresetCollectionRepository(client),
    });
    const likesApi = createMarketplaceLikesApi({
      repository: likes,
      trending: createPostgresMarketplaceTrendingRepository(poolLike),
      sessions,
      members,
      now: () => currentTime,
      createMemberId: () => 'member-must-not-be-created',
      createHandleSuffix: () => 'blocked1',
    });
    let moderationActionSequence = 0;
    const moderationApi = createMarketplaceModerationApi({
      repository: createPostgresMarketplaceModerationRepository(
        poolLike, DEFAULT_MARKETPLACE_TRENDING_POLICY,
      ),
      sessions: {
        async verify(request) {
          if (request.headers.get('x-admin') === 'true') {
            return {
              authUserId: 'auth-admin', email: 'admin@example.test',
              displayName: 'Admin', avatarUrl: null,
            };
          }
          return sessions.verify(request);
        },
      },
      members,
      adminAuthUserIds: new Set(['auth-admin']),
      now: () => currentTime,
      createId: () => `account-moderation-${++moderationActionSequence}`,
      createMemberId: () => 'member-must-not-be-created',
      createHandleSuffix: () => 'blocked1',
    });
    const getPreset = (id: string) => presetApi.fetch(new Request(
      `https://pedalboard.test/api/marketplace/presets/${id}`,
    ));
    const getCollection = (id: string) => collectionApi.fetch(new Request(
      `https://pedalboard.test/api/marketplace/collections/${id}`,
    ));

    const exportResponse = await accountRequest('GET', '/api/marketplace/me/export');
    assert.equal(exportResponse.status, 200);
    const exported = await exportResponse.json();
    assert.equal(exported.account.email, 'owner@example.test');
    assert.deepEqual(exported.presets.map((preset: { id: string }) => preset.id), [demoPublishedPreset.id]);
    assert.deepEqual(exported.collections.map((collection: { id: string }) => collection.id), [
      'collection-owner', 'collection-owner-hidden', 'collection-owner-withdrawn',
    ]);
    assert.deepEqual(exported.relationships.presetLikes.map((like: { presetId: string }) => like.presetId), ['preset-remix']);
    assert.equal(JSON.stringify(exported).includes('owner-session-secret'), false);
    assert.equal(JSON.stringify(exported).includes('other-private@example.test'), false);
    assert.equal(JSON.stringify(exported).includes('Must remain after source purge'), false);

    const requested = await accountRequest('POST');
    assert.equal(requested.status, 202);
    assert.equal(
      (await requested.json()).deletion.purgeAfter,
      new Date(databaseNow.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    );
    assert.equal((await getPreset(demoPublishedPreset.id)).status, 404);
    assert.equal((await getCollection('collection-owner')).status, 404);
    assert.equal((await accountRequest('GET')).status, 401);
    ownerCookie = await signIn('owner@example.test', 'Owner Secret Name');
    const pendingExport = await (await accountRequest(
      'GET', '/api/marketplace/me/export',
    )).json();
    assert.deepEqual(
      pendingExport.presets.map((preset: { id: string; visibility: string }) => (
        [preset.id, preset.visibility]
      )),
      [[demoPublishedPreset.id, 'withdrawn']],
    );
    assert.deepEqual(
      pendingExport.collections.map((collection: { id: string; visibility: string }) => (
        [collection.id, collection.visibility]
      )),
      [
        ['collection-owner', 'withdrawn'],
        ['collection-owner-hidden', 'hidden'],
        ['collection-owner-withdrawn', 'withdrawn'],
      ],
    );
    const blockedLike = await likesApi.fetch(new Request(
      'https://pedalboard.test/api/marketplace/likes/presets/preset-remix', {
        method: 'PUT', headers: { cookie: ownerCookie },
      },
    ));
    assert.equal(blockedLike.status, 403);
    assert.equal((await blockedLike.json()).error.code, 'account_deletion_pending');
    const blockedPublish = await presetApi.fetch(new Request(
      'https://pedalboard.test/api/marketplace/presets', {
        method: 'POST',
        headers: { cookie: ownerCookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Must not publish',
          description: 'Deletion already won the member lock.',
          tagIds: [demoPublishedPreset.tags[0].id],
          schemaVersion: demoPublishedPreset.currentRevision.schemaVersion,
          rig: demoPublishedPreset.currentRevision.rig,
        }),
      },
    ));
    assert.equal(blockedPublish.status, 403);
    assert.equal((await blockedPublish.json()).error.code, 'account_deletion_pending');
    const restoreWhileDeleting = await moderationApi.fetch(new Request(
      'https://pedalboard.test/api/marketplace/admin/moderation/actions', {
        method: 'POST',
        headers: { 'x-admin': 'true', 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'restore', subjectKind: 'collection',
          subjectId: 'collection-owner-hidden', reason: 'Must remain private while deleting',
        }),
      },
    ));
    assert.equal(restoreWhileDeleting.status, 403);
    assert.equal((await restoreWhileDeleting.json()).error.code, 'account_deletion_pending');
    const upholdWhileDeleting = await moderationApi.fetch(new Request(
      'https://pedalboard.test/api/marketplace/admin/moderation/appeals', {
        method: 'POST',
        headers: { 'x-admin': 'true', 'content-type': 'application/json' },
        body: JSON.stringify({
          appealId: 'appeal-owner-hidden', outcome: 'upheld',
          reason: 'Must remain private while deleting',
        }),
      },
    ));
    assert.equal(upholdWhileDeleting.status, 403);
    assert.equal((await upholdWhileDeleting.json()).error.code, 'account_deletion_pending');
    assert.equal((await getCollection('collection-owner-hidden')).status, 404);

    const memberApi = createMemberApi({
      members, sessions, now: () => currentTime,
      createId: () => 'unused-member', createHandleSuffix: () => 'unused1',
    });
    const current = await memberApi.fetch(new Request(
      'https://pedalboard.test/api/marketplace/me', { headers: { cookie: ownerCookie } },
    ));
    const currentMember = (await current.json()).member;
    const deniedWrite = await memberApi.fetch(new Request(
      'https://pedalboard.test/api/marketplace/me/profile', {
        method: 'PATCH', headers: { cookie: ownerCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: 'No write', expectedUpdatedAt: currentMember.updatedAt }),
      },
    ));
    assert.equal(deniedWrite.status, 403);
    assert.equal((await deniedWrite.json()).error.code, 'account_deletion_pending');

    currentTime = new Date(databaseNow.getTime() + 3 * 24 * 60 * 60 * 1000);
    assert.equal((await accountRequest('DELETE')).status, 200);
    assert.equal((await getPreset(demoPublishedPreset.id)).status, 200);
    assert.equal((await getCollection('collection-owner')).status, 200);
    const recoveredExport = await (await accountRequest(
      'GET', '/api/marketplace/me/export',
    )).json();
    assert.deepEqual(
      recoveredExport.collections.map((collection: { id: string; visibility: string }) => (
        [collection.id, collection.visibility]
      )),
      [
        ['collection-owner', 'public'],
        ['collection-owner-hidden', 'hidden'],
        ['collection-owner-withdrawn', 'withdrawn'],
      ],
    );

    currentTime = new Date(databaseNow.getTime() - 31 * 24 * 60 * 60 * 1000);
    assert.equal((await accountRequest('POST')).status, 202);
    assert.equal((await accountRequest('GET')).status, 401);
    ownerCookie = await signIn('owner@example.test', 'Owner Secret Name');
    const lateMagicLink = await requestMagicLink('owner@example.test', 'Owner Secret Name');
    currentTime = databaseNow;
    assert.equal((await accountRequest('DELETE')).status, 410);
    const purged = await api.fetch(new Request(
      'https://pedalboard.test/api/internal/marketplace/purge-deleted-accounts',
      { headers: { authorization: 'Bearer cron-secret' } },
    ));
    assert.deepEqual(await purged.json(), { purgedMemberIds: [ownerId] });
    const exportAfterPurge = await accountRequest('GET', '/api/marketplace/me/export');
    assert.equal(exportAfterPurge.status, 401);
    assert.equal(await verifyMagicLink(lateMagicLink), null);
    const popularAfterPurge = await likesApi.fetch(new Request(
      'https://pedalboard.test/api/marketplace/popular/presets',
    ));
    assert.equal(
      (await popularAfterPurge.json()).items.some((item: { id: string }) => item.id === 'preset-remix'),
      false,
    );
    const remixLikeState = await likesApi.fetch(new Request(
      'https://pedalboard.test/api/marketplace/likes/presets/preset-remix',
    ));
    assert.equal((await remixLikeState.json()).state.likeCount, 0);
    const governanceQueue = await moderationApi.fetch(new Request(
      'https://pedalboard.test/api/marketplace/admin/moderation/queue', {
        headers: { 'x-admin': 'true' },
      },
    ));
    assert.equal(
      (await governanceQueue.json()).items.some((item: { id: string }) => item.id === 'report-owner'),
      true,
    );

    const remixResponse = await getPreset('preset-remix');
    assert.equal(remixResponse.status, 200);
    const remix = (await remixResponse.json()).preset;
    assert.equal(remix?.source?.availability, 'unavailable');
    assert.equal(remix?.source?.title, null);
    assert.equal(remix?.source?.creator.displayName, 'Deleted member');
    const collectionResponse = await getCollection('collection-other');
    assert.equal(collectionResponse.status, 200);
    const collection = (await collectionResponse.json()).collection;
    assert.equal(collection?.items[0].availability, 'unavailable');
    assert.equal(collection?.items[0].title, null);
    assert.equal(collection?.items[0].creator.displayName, 'Deleted member');
    assert.equal((await memberApi.fetch(new Request(
      `https://pedalboard.test/api/marketplace/creators/id/${ownerId}`,
    ))).status, 404);
    assert.equal((await memberApi.fetch(new Request(
      'https://pedalboard.test/api/marketplace/creators/guitar-pedalboard',
    ))).status, 404);

    ownerCookie = await signIn('owner@example.test', 'Owner Secret Name');
    assert.equal((await accountRequest('GET', '/api/marketplace/me/export')).status, 404);

    const otherCookie = await signIn('other-private@example.test', 'Other Member');
    const otherCurrent = await memberApi.fetch(new Request(
      'https://pedalboard.test/api/marketplace/me', { headers: { cookie: otherCookie } },
    ));
    const otherProfile = (await otherCurrent.json()).member;
    const reuseDeletedHandle = await memberApi.fetch(new Request(
      'https://pedalboard.test/api/marketplace/me/profile', {
        method: 'PATCH',
        headers: { cookie: otherCookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          handle: 'guitar-pedalboard', expectedUpdatedAt: otherProfile.updatedAt,
        }),
      },
    ));
    assert.equal(reuseDeletedHandle.status, 409);
    assert.equal((await reuseDeletedHandle.json()).error.code, 'handle_unavailable');
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
});
