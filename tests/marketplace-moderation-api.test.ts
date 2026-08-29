import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuthenticatedIdentity } from '../server/auth/session.ts';
import { createMemoryMemberRepository } from '../server/members/memoryRepository.ts';
import { assertAccountActive } from '../server/members/standing.ts';
import { createMarketplaceModerationApi } from '../server/moderation/api.ts';
import { createMemoryMarketplaceModerationRepository } from '../server/moderation/memoryRepository.ts';
import type { MarketplaceWriteLimiter } from '../server/abuse/writeLimiter.ts';

const now = new Date('2026-08-29T14:00:00.000Z');
const identities: Record<string, AuthenticatedIdentity> = {
  reporter: { authUserId: 'auth-reporter', email: 'reporter@example.test', displayName: 'Reporter', avatarUrl: null },
  other: { authUserId: 'auth-other', email: 'other@example.test', displayName: 'Other', avatarUrl: null },
  author: { authUserId: 'auth-author', email: 'author@example.test', displayName: 'Author', avatarUrl: null },
  admin: { authUserId: 'auth-admin', email: 'admin@example.test', displayName: 'Admin', avatarUrl: null },
  unverified: {
    authUserId: 'auth-unverified', email: 'unverified@example.test', emailVerified: false,
    displayName: 'Unverified', avatarUrl: null,
  },
};

function fixture(writeLimiter?: MarketplaceWriteLimiter) {
  const members = createMemoryMemberRepository(Object.entries(identities).map(([key, identity]) => ({
    id: `member-${key}`,
    authUserId: identity.authUserId,
    handle: key === 'admin' ? 'site-admin' : key,
    displayName: identity.displayName,
    bio: '', avatarUrl: null, handleChangedAt: null,
    createdAt: now, updatedAt: now, communityStatus: 'active' as const,
  })));
  const repository = createMemoryMarketplaceModerationRepository({
    targets: [
      { kind: 'preset', id: 'preset-a', creatorId: 'member-author', visibility: 'public' },
      { kind: 'collection', id: 'collection-a', creatorId: 'member-author', visibility: 'unlisted' },
      { kind: 'member', id: 'member-author', creatorId: 'member-author', visibility: 'public' },
    ],
    setMemberStatus: members.setCommunityStatus,
    async setTargetVisibility() {},
    async standingChanged() {},
    async contentRestorable(memberId) {
      const member = await members.findById(memberId);
      if (!member) throw new Error('Member not found');
      assertAccountActive(member);
    },
  });
  let id = 0;
  const api = createMarketplaceModerationApi({
    repository,
    sessions: {
      async verify(request) { return identities[request.headers.get('x-user') ?? ''] ?? null; },
    },
    members,
    adminAuthUserIds: new Set(['auth-admin']),
    now: () => now,
    createId: () => `governance-${++id}`,
    createMemberId: () => 'member-created',
    createHandleSuffix: () => 'created1',
    writeLimiter,
  });
  const request = (path: string, method = 'GET', user?: string, body?: unknown) => api.fetch(new Request(
    `https://pedalboard.test${path}`,
    {
      method,
      headers: user ? { 'x-user': user, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  ));
  return { members, request };
}

const report = {
  targetKind: 'preset', targetId: 'preset-a', reason: 'spam', details: 'Repeated misleading promotion.',
};

test('verified members report accessible content once while formal notices stay anonymous and distinct', async () => {
  const { request } = fixture();
  assert.equal((await request('/api/marketplace/reports', 'POST', undefined, report)).status, 401);
  const accepted = await request('/api/marketplace/reports', 'POST', 'reporter', report);
  assert.equal(accepted.status, 201);
  assert.deepEqual(await accepted.json(), { report: { id: 'governance-1' } });
  assert.equal((await request('/api/marketplace/reports', 'POST', 'reporter', report)).status, 409);
  assert.equal((await request('/api/marketplace/reports', 'POST', 'reporter', {
    ...report, targetId: 'missing',
  })).status, 404);
  assert.equal((await request('/api/marketplace/reports', 'POST', 'reporter', {
    ...report, targetKind: 'collection', targetId: 'collection-a',
  })).status, 201);
  assert.equal((await request('/api/marketplace/reports', 'POST', 'other', {
    ...report, targetKind: 'member', targetId: 'member-author', reason: 'impersonation',
  })).status, 201);

  const notice = {
    claimantName: 'Rights Holder',
    claimantEmail: 'rights@example.test',
    targetKind: 'collection',
    targetId: 'collection-a',
    rightsStatement: 'I own the identified work and request a formal review.',
    goodFaith: true,
  };
  assert.equal((await request('/api/marketplace/infringement-notices', 'POST', undefined, {
    ...notice, goodFaith: false,
  })).status, 400);
  assert.equal((await request('/api/marketplace/infringement-notices', 'POST', undefined, notice)).status, 201);

  assert.equal((await request('/api/marketplace/admin/moderation/queue', 'GET', 'reporter')).status, 403);
  const queue = await (await request('/api/marketplace/admin/moderation/queue', 'GET', 'admin')).json();
  assert.deepEqual(queue.items.map((item: { kind: string }) => item.kind), ['report', 'report', 'report', 'notice']);
  const queuedNotice = queue.items.find((item: { kind: string }) => item.kind === 'notice');
  assert.equal(queuedNotice.claimantName, 'Rights Holder');
  assert.equal(queuedNotice.claimantEmail, 'rights@example.test');
  assert.equal(JSON.stringify(queue).includes('auth-'), false);
  assert.equal(JSON.stringify(queue).includes('token'), false);
});

test('ordinary reports require email verification without hiding the signed-in state', async () => {
  const { request } = fixture();
  const response = await request('/api/marketplace/reports', 'POST', 'unverified', report);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'email_verification_required',
      message: 'Verify your email before this community write',
      verificationUrl: '/login?verify=email&return=%2Fmarketplace',
    },
  });
});

test('ordinary reports use the dedicated report limiter after body validation', async () => {
  const operations: string[] = [];
  const { request } = fixture({
    async consume(input) {
      operations.push(input.operation);
      return { allowed: false, retryAt: new Date('2026-08-29T14:01:00.000Z') };
    },
  });
  const response = await request('/api/marketplace/reports', 'POST', 'reporter', report);
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.retryAt, '2026-08-29T14:01:00.000Z');
  assert.deepEqual(operations, ['report']);
});

test('only admins hide content; authors see the reason and get one appeal with a private audit trail', async () => {
  const { request } = fixture();
  const hide = {
    action: 'hide', subjectKind: 'preset', subjectId: 'preset-a', reason: 'Impersonation evidence confirmed.',
  };
  assert.equal((await request('/api/marketplace/admin/moderation/actions', 'POST', 'other', hide)).status, 403);
  assert.equal((await request('/api/marketplace/admin/moderation/actions', 'POST', 'admin', hide)).status, 204);
  assert.equal((await request('/api/marketplace/reports', 'POST', 'reporter', report)).status, 404);

  assert.deepEqual(
    (await (await request('/api/marketplace/me/moderation', 'GET', 'other')).json()).cases,
    [],
  );
  const authorCases = await (await request('/api/marketplace/me/moderation', 'GET', 'author')).json();
  assert.equal(authorCases.cases[0].reason, hide.reason);
  const actionId = authorCases.cases[0].actionId;
  assert.equal((await request('/api/marketplace/moderation/appeals', 'POST', 'other', {
    actionId, statement: 'I am not the author.',
  })).status, 403);
  assert.equal((await request('/api/marketplace/moderation/appeals', 'POST', 'author', {
    actionId, statement: 'The attribution is accurate; please review.',
  })).status, 201);
  assert.equal((await request('/api/marketplace/moderation/appeals', 'POST', 'author', {
    actionId, statement: 'A second appeal must not be accepted.',
  })).status, 409);

  const queue = await (await request('/api/marketplace/admin/moderation/queue', 'GET', 'admin')).json();
  const appealId = queue.items.find((item: { kind: string }) => item.kind === 'appeal').id;
  assert.equal((await request('/api/marketplace/admin/moderation/appeals', 'POST', 'admin', {
    appealId, outcome: 'upheld', reason: 'Attribution verified on review.',
  })).status, 204);
  assert.equal((await request('/api/marketplace/reports', 'POST', 'reporter', report)).status, 201);

  assert.equal((await request('/api/marketplace/admin/moderation/audit', 'GET', 'author')).status, 403);
  const audit = await (await request('/api/marketplace/admin/moderation/audit', 'GET', 'admin')).json();
  assert.deepEqual(audit.entries.map((entry: { action: string }) => entry.action), [
    'hide', 'uphold_appeal',
  ]);
  assert.equal(JSON.stringify(audit).includes('password'), false);
  assert.equal(JSON.stringify(audit).includes('token'), false);
});

test('an old upheld appeal cannot undo a newer hide, and a rejected appeal keeps content hidden', async () => {
  const { request } = fixture();
  const action = (name: 'hide' | 'restore', reason: string) => request(
    '/api/marketplace/admin/moderation/actions',
    'POST',
    'admin',
    { action: name, subjectKind: 'preset', subjectId: 'preset-a', reason },
  );

  assert.equal((await action('hide', 'First decision.')).status, 204);
  let cases = (await (await request('/api/marketplace/me/moderation', 'GET', 'author')).json()).cases;
  const firstActionId = cases.find((item: { reason: string }) => item.reason === 'First decision.').actionId;
  assert.equal((await request('/api/marketplace/moderation/appeals', 'POST', 'author', {
    actionId: firstActionId, statement: 'Please review the first decision.',
  })).status, 201);
  const firstAppealId = (await (
    await request('/api/marketplace/admin/moderation/queue', 'GET', 'admin')
  ).json()).items.find((item: { kind: string }) => item.kind === 'appeal').id;

  assert.equal((await action('restore', 'First restriction removed.')).status, 204);
  assert.equal((await action('hide', 'New independent evidence.')).status, 204);
  assert.equal((await request('/api/marketplace/admin/moderation/appeals', 'POST', 'admin', {
    appealId: firstAppealId, outcome: 'upheld', reason: 'The first decision was incorrect.',
  })).status, 204);
  assert.equal((await request('/api/marketplace/reports', 'POST', 'reporter', report)).status, 404);

  cases = (await (await request('/api/marketplace/me/moderation', 'GET', 'author')).json()).cases;
  const secondActionId = cases.find((item: { reason: string }) => (
    item.reason === 'New independent evidence.'
  )).actionId;
  assert.equal((await request('/api/marketplace/moderation/appeals', 'POST', 'author', {
    actionId: secondActionId, statement: 'Please review the newer decision.',
  })).status, 201);
  const secondAppealId = (await (
    await request('/api/marketplace/admin/moderation/queue', 'GET', 'admin')
  ).json()).items.find((item: { kind: string }) => item.kind === 'appeal').id;
  assert.equal((await request('/api/marketplace/admin/moderation/appeals', 'POST', 'admin', {
    appealId: secondAppealId, outcome: 'rejected', reason: 'The newer evidence is valid.',
  })).status, 204);
  assert.equal((await request('/api/marketplace/reports', 'POST', 'reporter', report)).status, 404);
  assert.equal((await action('restore', 'New restriction removed.')).status, 204);
  assert.equal((await request('/api/marketplace/reports', 'POST', 'reporter', report)).status, 201);
});

test('banned members retain read access but cannot report, and admin actions cannot transfer ownership', async () => {
  const { request } = fixture();
  assert.equal((await request('/api/marketplace/admin/moderation/actions', 'POST', 'admin', {
    action: 'ban', subjectKind: 'member', subjectId: 'member-reporter', reason: 'Repeated abuse.',
  })).status, 204);
  assert.equal((await request('/api/marketplace/me/moderation', 'GET', 'reporter')).status, 200);
  assert.equal((await request('/api/marketplace/reports', 'POST', 'reporter', report)).status, 403);
  assert.equal((await request('/api/marketplace/admin/moderation/actions', 'POST', 'admin', {
    action: 'transfer', subjectKind: 'preset', subjectId: 'preset-a', reason: 'Not allowed.',
  })).status, 400);
});

test('pending account deletion blocks admin restore and an upheld appeal from exposing hidden content', async () => {
  const { members, request } = fixture();
  const hide = {
    action: 'hide', subjectKind: 'preset', subjectId: 'preset-a', reason: 'Pending review.',
  };
  assert.equal((await request(
    '/api/marketplace/admin/moderation/actions', 'POST', 'admin', hide,
  )).status, 204);
  const cases = (await (await request(
    '/api/marketplace/me/moderation', 'GET', 'author',
  )).json()).cases;
  assert.equal((await request('/api/marketplace/moderation/appeals', 'POST', 'author', {
    actionId: cases[0].actionId, statement: 'Please restore this work.',
  })).status, 201);
  const appealId = (await (await request(
    '/api/marketplace/admin/moderation/queue', 'GET', 'admin',
  )).json()).items.find((item: { kind: string }) => item.kind === 'appeal').id;
  await members.setAccountStatus('member-author', 'pending_deletion', now);

  const restore = await request('/api/marketplace/admin/moderation/actions', 'POST', 'admin', {
    action: 'restore', subjectKind: 'preset', subjectId: 'preset-a', reason: 'Would expose deletion.',
  });
  assert.equal(restore.status, 403);
  assert.equal((await restore.json()).error.code, 'account_deletion_pending');
  const uphold = await request('/api/marketplace/admin/moderation/appeals', 'POST', 'admin', {
    appealId, outcome: 'upheld', reason: 'Would expose deletion.',
  });
  assert.equal(uphold.status, 403);
  assert.equal((await uphold.json()).error.code, 'account_deletion_pending');
  assert.equal((await request('/api/marketplace/reports', 'POST', 'reporter', report)).status, 404);
});
