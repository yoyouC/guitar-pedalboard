import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Client, Pool } from 'pg';
import type { AuthenticatedIdentity } from '../server/auth/session.ts';
import { createMarketplaceLikesApi } from '../server/likes/api.ts';
import { createPostgresMarketplaceLikeRepository } from '../server/likes/postgresRepository.ts';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';
import { createPostgresPublishedPresetRepository } from '../server/marketplace/postgresRepository.ts';
import { seedPublishedPreset } from '../server/marketplace/seed.ts';
import { createPostgresMemberRepository } from '../server/members/postgresRepository.ts';
import { BannedMemberError } from '../server/members/standing.ts';
import { createMarketplaceModerationApi } from '../server/moderation/api.ts';
import { createPostgresMarketplaceModerationRepository } from '../server/moderation/postgresRepository.ts';
import { DEFAULT_MARKETPLACE_TRENDING_POLICY } from '../server/trending/policy.ts';
import { createPostgresMarketplaceTrendingRepository } from '../server/trending/postgresRepository.ts';

const connectionString = process.env.MARKETPLACE_TEST_DATABASE_URL;

test('PostgreSQL moderation enforces lifecycle, privacy, bans, and recognition exclusion', {
  skip: connectionString ? false : 'Set MARKETPLACE_TEST_DATABASE_URL for PostgreSQL moderation integration',
}, async () => {
  const client = new Client({ connectionString });
  const schema = `marketplace_moderation_${process.pid}_${Date.now()}`;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    for (const migration of [
      '0001_published_presets.sql', '0002_authentication.sql', '0003_member_profiles.sql',
      '0004_preset_publication.sql', '0005_preset_revision_management.sql',
      '0006_preset_remix_provenance.sql', '0007_preset_collections.sql',
      '0008_preset_search_indexes.sql', '0009_marketplace_likes.sql',
      '0010_marketplace_trending.sql', '0011_marketplace_moderation.sql',
      '0012_tag_administration.sql',
    ]) {
      await client.query(await readFile(
        new URL(`../server/marketplace/migrations/${migration}`, import.meta.url), 'utf8',
      ));
    }
    await client.query('BEGIN');
    await seedPublishedPreset(client, demoPublishedPreset);
    await client.query('COMMIT');
    const identities: Record<string, AuthenticatedIdentity> = {
      reporter: { authUserId: 'auth-reporter', email: 'reporter@example.test', displayName: 'Reporter', avatarUrl: null },
      author: { authUserId: 'auth-author', email: 'author@example.test', displayName: 'Author', avatarUrl: null },
      admin: { authUserId: 'auth-admin', email: 'admin@example.test', displayName: 'Admin', avatarUrl: null },
    };
    for (const [key, identity] of Object.entries(identities)) {
      await client.query(
        `INSERT INTO marketplace_auth_users
           (id, name, email, "emailVerified", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, true, $4, $4)`,
        [identity.authUserId, identity.displayName, identity.email, new Date(0)],
      );
      const memberId = key === 'author' ? demoPublishedPreset.creator.id : `member-${key}`;
      if (key !== 'author') {
        await client.query(
          `INSERT INTO marketplace_members (id, handle, display_name) VALUES ($1, $2, $3)`,
          [memberId, key === 'admin' ? 'site-admin' : key, identity.displayName],
        );
      }
      await client.query(
        `INSERT INTO marketplace_member_auth_identities (auth_user_id, member_id)
         VALUES ($1, $2)`,
        [identity.authUserId, memberId],
      );
    }
    await client.query(
      `INSERT INTO marketplace_preset_collections
         (id, creator_id, title, description, visibility)
       VALUES ('collection-moderation', $1, 'Moderation Collection', '', 'public')`,
      [demoPublishedPreset.creator.id],
    );

    const poolLike = {
      query: client.query.bind(client),
      async connect() { return { query: client.query.bind(client), release() {} }; },
    } as unknown as Pool;
    const sessions = {
      async verify(request: Request) { return identities[request.headers.get('x-user') ?? ''] ?? null; },
    };
    const members = createPostgresMemberRepository(poolLike);
    const likes = createPostgresMarketplaceLikeRepository(poolLike);
    const trending = createPostgresMarketplaceTrendingRepository(poolLike);
    let id = 0;
    const now = new Date('2026-08-29T15:00:00.000Z');
    const moderation = createMarketplaceModerationApi({
      repository: createPostgresMarketplaceModerationRepository(
        poolLike,
        DEFAULT_MARKETPLACE_TRENDING_POLICY,
      ),
      sessions,
      members,
      adminAuthUserIds: new Set(['auth-admin']),
      now: () => now,
      createId: () => `moderation-pg-${++id}`,
      createMemberId: () => 'unused-member',
      createHandleSuffix: () => 'unused1',
    });
    const likesApi = createMarketplaceLikesApi({
      repository: likes, trending, sessions, members, now: () => now,
      createMemberId: () => 'unused-member', createHandleSuffix: () => 'unused1',
    });
    const request = (path: string, method = 'GET', user?: string, body?: unknown) => moderation.fetch(
      new Request(`https://pedalboard.test${path}`, {
        method,
        headers: user ? { 'x-user': user, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

    assert.equal((await request('/api/marketplace/reports', 'POST', 'reporter', {
      targetKind: 'preset', targetId: demoPublishedPreset.id,
      reason: 'impersonation', details: 'The creator identity appears misleading.',
    })).status, 201);
    assert.equal((await request('/api/marketplace/infringement-notices', 'POST', undefined, {
      claimantName: 'Rights Holder', claimantEmail: 'rights@example.test',
      targetKind: 'collection', targetId: 'collection-moderation',
      rightsStatement: 'I own the identified material and request formal review.', goodFaith: true,
    })).status, 201);
    const queue = await (await request('/api/marketplace/admin/moderation/queue', 'GET', 'admin')).json();
    assert.deepEqual(queue.items.map((item: { kind: string }) => item.kind), ['report', 'notice']);
    assert.equal(queue.items[1].claimantName, 'Rights Holder');
    assert.equal(queue.items[1].claimantEmail, 'rights@example.test');

    assert.equal((await request('/api/marketplace/admin/moderation/actions', 'POST', 'admin', {
      action: 'hide', subjectKind: 'preset', subjectId: demoPublishedPreset.id,
      reason: 'Identity evidence requires removal.',
    })).status, 204);
    assert.equal(
      await createPostgresPublishedPresetRepository(poolLike).findVisibleById(demoPublishedPreset.id),
      null,
    );
    const cases = await (await request('/api/marketplace/me/moderation', 'GET', 'author')).json();
    assert.equal(cases.cases[0].reason, 'Identity evidence requires removal.');
    assert.equal((await request('/api/marketplace/moderation/appeals', 'POST', 'author', {
      actionId: cases.cases[0].actionId, statement: 'The identity and attribution are verifiable.',
    })).status, 201);
    const appealQueue = await (await request('/api/marketplace/admin/moderation/queue', 'GET', 'admin')).json();
    const appealId = appealQueue.items.find((item: { kind: string }) => item.kind === 'appeal').id;
    assert.equal((await request('/api/marketplace/admin/moderation/appeals', 'POST', 'admin', {
      appealId, outcome: 'upheld', reason: 'Verified attribution.',
    })).status, 204);
    assert.ok(await createPostgresPublishedPresetRepository(poolLike).findVisibleById(demoPublishedPreset.id));

    assert.equal((await request('/api/marketplace/admin/moderation/actions', 'POST', 'admin', {
      action: 'hide', subjectKind: 'preset', subjectId: demoPublishedPreset.id,
      reason: 'Older decision under review.',
    })).status, 204);
    let laterCases = (await (
      await request('/api/marketplace/me/moderation', 'GET', 'author')
    ).json()).cases;
    const olderActionId = laterCases.find((item: { reason: string }) => (
      item.reason === 'Older decision under review.'
    )).actionId;
    assert.equal((await request('/api/marketplace/moderation/appeals', 'POST', 'author', {
      actionId: olderActionId, statement: 'Please review the older decision.',
    })).status, 201);
    const olderAppealId = (await (
      await request('/api/marketplace/admin/moderation/queue', 'GET', 'admin')
    ).json()).items.find((item: { kind: string }) => item.kind === 'appeal').id;
    assert.equal((await request('/api/marketplace/admin/moderation/actions', 'POST', 'admin', {
      action: 'restore', subjectKind: 'preset', subjectId: demoPublishedPreset.id,
      reason: 'Older restriction removed.',
    })).status, 204);
    const concurrentPool = new Pool({
      connectionString,
      options: `-c search_path=${schema}`,
    });
    let releaseAppealRead = () => {};
    let appealReadFinished = () => {};
    const appealRead = new Promise<void>((resolve) => { appealReadFinished = resolve; });
    const continueResolution = new Promise<void>((resolve) => { releaseAppealRead = resolve; });
    const gatedPool = {
      query: concurrentPool.query.bind(concurrentPool),
      async connect() {
        const connection = await concurrentPool.connect();
        return {
          async query(text: string, values?: readonly unknown[]) {
            const result = await connection.query(text, values as unknown[] | undefined);
            if (text.includes('FOR UPDATE OF appeal')) {
              appealReadFinished();
              await continueResolution;
            }
            return result;
          },
          release() { connection.release(); },
        };
      },
    } as unknown as Pool;
    try {
      const gatedApi = createMarketplaceModerationApi({
        repository: createPostgresMarketplaceModerationRepository(
          gatedPool,
          DEFAULT_MARKETPLACE_TRENDING_POLICY,
        ),
        sessions,
        members,
        adminAuthUserIds: new Set(['auth-admin']),
        now: () => now,
        createId: () => 'moderation-concurrent-old-appeal',
        createMemberId: () => 'unused-member',
        createHandleSuffix: () => 'unused1',
      });
      const liveApi = createMarketplaceModerationApi({
        repository: createPostgresMarketplaceModerationRepository(
          concurrentPool,
          DEFAULT_MARKETPLACE_TRENDING_POLICY,
        ),
        sessions,
        members,
        adminAuthUserIds: new Set(['auth-admin']),
        now: () => now,
        createId: () => 'moderation-concurrent-new-hide',
        createMemberId: () => 'unused-member',
        createHandleSuffix: () => 'unused1',
      });
      const resolvingOlderAppeal = gatedApi.fetch(new Request(
        'https://pedalboard.test/api/marketplace/admin/moderation/appeals',
        {
          method: 'POST', headers: { 'x-user': 'admin', 'content-type': 'application/json' },
          body: JSON.stringify({
            appealId: olderAppealId,
            outcome: 'upheld',
            reason: 'Only the older decision was incorrect.',
          }),
        },
      ));
      await appealRead;
      assert.equal((await liveApi.fetch(new Request(
        'https://pedalboard.test/api/marketplace/admin/moderation/actions',
        {
          method: 'POST', headers: { 'x-user': 'admin', 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'hide', subjectKind: 'preset', subjectId: demoPublishedPreset.id,
            reason: 'New independent evidence.',
          }),
        },
      ))).status, 204);
      releaseAppealRead();
      assert.equal((await resolvingOlderAppeal).status, 204);
    } finally {
      releaseAppealRead();
      await concurrentPool.end();
    }
    assert.equal(
      await createPostgresPublishedPresetRepository(poolLike).findVisibleById(demoPublishedPreset.id),
      null,
    );
    laterCases = (await (
      await request('/api/marketplace/me/moderation', 'GET', 'author')
    ).json()).cases;
    const newerActionId = laterCases.find((item: { reason: string }) => (
      item.reason === 'New independent evidence.'
    )).actionId;
    assert.equal((await request('/api/marketplace/moderation/appeals', 'POST', 'author', {
      actionId: newerActionId, statement: 'Please review the newer decision.',
    })).status, 201);
    const newerAppealId = (await (
      await request('/api/marketplace/admin/moderation/queue', 'GET', 'admin')
    ).json()).items.find((item: { kind: string }) => item.kind === 'appeal').id;
    assert.equal((await request('/api/marketplace/admin/moderation/appeals', 'POST', 'admin', {
      appealId: newerAppealId, outcome: 'rejected', reason: 'The newer evidence remains valid.',
    })).status, 204);
    assert.equal(
      await createPostgresPublishedPresetRepository(poolLike).findVisibleById(demoPublishedPreset.id),
      null,
    );
    assert.equal((await request('/api/marketplace/admin/moderation/actions', 'POST', 'admin', {
      action: 'restore', subjectKind: 'preset', subjectId: demoPublishedPreset.id,
      reason: 'New restriction removed.',
    })).status, 204);
    assert.ok(await createPostgresPublishedPresetRepository(poolLike).findVisibleById(demoPublishedPreset.id));

    await client.query(
      `UPDATE marketplace_preset_collections SET visibility = 'withdrawn'
       WHERE id = 'collection-moderation'`,
    );
    assert.equal((await request('/api/marketplace/admin/moderation/actions', 'POST', 'admin', {
      action: 'hide', subjectKind: 'collection', subjectId: 'collection-moderation',
      reason: 'Governance review while author-withdrawn.',
    })).status, 204);
    assert.equal((await request('/api/marketplace/admin/moderation/actions', 'POST', 'admin', {
      action: 'restore', subjectKind: 'collection', subjectId: 'collection-moderation',
      reason: 'Governance restriction removed.',
    })).status, 204);
    assert.equal((await client.query(
      `SELECT visibility FROM marketplace_preset_collections WHERE id = 'collection-moderation'`,
    )).rows[0].visibility, 'withdrawn');

    const likePath = `/api/marketplace/likes/presets/${demoPublishedPreset.id}`;
    assert.equal((await likesApi.fetch(new Request(`https://pedalboard.test${likePath}`, {
      method: 'PUT', headers: { 'x-user': 'reporter' },
    }))).status, 200);
    await trending.rebuild({ now, policy: DEFAULT_MARKETPLACE_TRENDING_POLICY });
    assert.equal((await likes.getState('preset', demoPublishedPreset.id, null)).likeCount, 1);
    const failingProjectionApi = createMarketplaceModerationApi({
      repository: createPostgresMarketplaceModerationRepository(poolLike, {
        windowHours: 0,
        halfLifeHours: 0,
      }),
      sessions,
      members,
      adminAuthUserIds: new Set(['auth-admin']),
      now: () => now,
      createId: () => 'moderation-projection-must-rollback',
      createMemberId: () => 'unused-member',
      createHandleSuffix: () => 'unused1',
    });
    assert.equal((await failingProjectionApi.fetch(new Request(
      'https://pedalboard.test/api/marketplace/admin/moderation/actions',
      {
        method: 'POST',
        headers: { 'x-user': 'admin', 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'ban', subjectKind: 'member', subjectId: 'member-reporter',
          reason: 'This action must roll back with its failed projections.',
        }),
      },
    ))).status, 503);
    assert.equal((await client.query(
      `SELECT community_status FROM marketplace_members WHERE id = 'member-reporter'`,
    )).rows[0].community_status, 'active');
    assert.equal((await likes.getState('preset', demoPublishedPreset.id, null)).likeCount, 1);
    assert.equal((await request('/api/marketplace/admin/moderation/actions', 'POST', 'admin', {
      action: 'ban', subjectKind: 'member', subjectId: 'member-reporter', reason: 'Repeated abuse.',
    })).status, 204);
    assert.equal((await likes.getState('preset', demoPublishedPreset.id, null)).likeCount, 0);
    assert.deepEqual((await likes.listPopular({ kind: 'preset', limit: 20, cursor: null })).items, []);
    assert.deepEqual((await trending.list({ kind: 'preset', limit: 20, cursor: null })).items, []);
    assert.equal(Number((await client.query(
      `SELECT count(*) AS count FROM marketplace_preset_likes WHERE member_id = 'member-reporter'`,
    )).rows[0].count), 1);
    await assert.rejects(
      likes.setLiked({
        kind: 'preset', targetId: demoPublishedPreset.id,
        memberId: 'member-reporter', liked: true, now,
      }),
      BannedMemberError,
    );
    assert.equal((await likesApi.fetch(new Request(`https://pedalboard.test${likePath}`, {
      method: 'DELETE', headers: { 'x-user': 'reporter' },
    }))).status, 403);
    assert.equal((await request('/api/marketplace/reports', 'POST', 'reporter', {
      targetKind: 'preset', targetId: demoPublishedPreset.id,
      reason: 'spam', details: 'Banned members cannot submit this.',
    })).status, 403);
    assert.equal((await request('/api/marketplace/admin/moderation/actions', 'POST', 'admin', {
      action: 'unban', subjectKind: 'member', subjectId: 'member-reporter', reason: 'Restriction lifted.',
    })).status, 204);
    assert.equal((await likes.getState('preset', demoPublishedPreset.id, null)).likeCount, 1);
    assert.deepEqual(
      (await likes.listPopular({ kind: 'preset', limit: 20, cursor: null })).items
        .map((item) => item.id),
      [demoPublishedPreset.id],
    );
    assert.deepEqual(
      (await trending.list({ kind: 'preset', limit: 20, cursor: null })).items
        .map((item) => item.id),
      [demoPublishedPreset.id],
    );
    assert.equal((await likesApi.fetch(new Request(`https://pedalboard.test${likePath}`, {
      method: 'DELETE', headers: { 'x-user': 'reporter' },
    }))).status, 200);

    assert.equal((await request('/api/marketplace/admin/moderation/audit', 'GET', 'author')).status, 403);
    const audit = await (await request('/api/marketplace/admin/moderation/audit', 'GET', 'admin')).json();
    assert.deepEqual(audit.entries.map((entry: { action: string }) => entry.action), [
      'unban', 'ban', 'restore', 'hide',
      'restore', 'reject_appeal', 'uphold_appeal', 'hide', 'restore', 'hide',
      'uphold_appeal', 'hide',
    ]);
    assert.equal(JSON.stringify(audit).includes('accessToken'), false);
    assert.equal(JSON.stringify(audit).includes('password'), false);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
});
