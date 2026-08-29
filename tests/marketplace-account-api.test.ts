import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarketplaceAccountApi } from '../server/accounts/api.ts';
import {
  ACCOUNT_DELETION_GRACE_MS,
  MarketplaceAccountDeletionNotPendingError,
  type MarketplaceAccountRepository,
} from '../server/accounts/repository.ts';
import type { MarketplaceAccountExport } from '../shared/account.ts';

const now = new Date('2026-08-29T12:00:00.000Z');
const exported: MarketplaceAccountExport = {
  formatVersion: 1,
  exportedAt: now.toISOString(),
  account: { email: 'ada@example.test' },
  member: {
    id: 'member-ada', handle: 'ada-tones', displayName: 'Ada', bio: '', avatarUrl: null,
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
  },
  presets: [], collections: [],
  relationships: {
    presetLikes: [], collectionLikes: [], moderationReports: [], moderationAppeals: [],
  },
};

function repository(): MarketplaceAccountRepository & { calls: string[] } {
  const calls: string[] = [];
  let pending = false;
  return {
    calls,
    async exportByAuthUserId(authUserId) {
      calls.push(`export:${authUserId}`);
      return exported;
    },
    async findDeletion(authUserId) {
      calls.push(`status:${authUserId}`);
      return pending ? {
        status: 'pending',
        requestedAt: now.toISOString(),
        purgeAfter: new Date(now.getTime() + ACCOUNT_DELETION_GRACE_MS).toISOString(),
      } : null;
    },
    async requestDeletion(authUserId, requestedAt) {
      calls.push(`delete:${authUserId}`);
      pending = true;
      return {
        status: 'pending',
        requestedAt: requestedAt.toISOString(),
        purgeAfter: new Date(requestedAt.getTime() + ACCOUNT_DELETION_GRACE_MS).toISOString(),
      };
    },
    async recoverDeletion(authUserId) {
      calls.push(`recover:${authUserId}`);
      if (!pending) throw new MarketplaceAccountDeletionNotPendingError();
      pending = false;
    },
    async purgeDue() {
      calls.push('purge');
      return ['member-expired'];
    },
  };
}

function fixture() {
  const repo = repository();
  const api = createMarketplaceAccountApi({
    repository: repo,
    sessions: {
      async verify(request) {
        return request.headers.get('x-user') === 'ada' ? {
          authUserId: 'auth-ada', email: 'ada@example.test',
          emailVerified: request.headers.get('x-email-verified') !== 'false',
          displayName: 'Ada', avatarUrl: null,
        } : null;
      },
    },
    now: () => now,
    cronSecret: 'cron-secret',
  });
  const request = (
    path: string,
    method = 'GET',
    authenticated = true,
    body?: string,
    emailVerified = true,
  ) => api.fetch(
    new Request(`https://pedalboard.test${path}`, {
      method,
      headers: authenticated ? {
        'x-user': 'ada',
        'x-email-verified': String(emailVerified),
      } : {},
      ...(body === undefined ? {} : { body }),
    }),
  );
  return { api, repo, request };
}

test('member export is private, downloadable JSON through one authenticated boundary', async () => {
  const { request, repo } = fixture();
  assert.equal((await request('/api/marketplace/me/export', 'GET', false)).status, 401);
  const response = await request('/api/marketplace/me/export');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition') ?? '', /guitar-pedalboard-export-2026-08-29\.json/);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await response.json(), exported);
  assert.deepEqual(repo.calls, ['export:auth-ada']);
});

test('deletion request, verified recovery, and scheduler purge have separate authority', async () => {
  const { api, request, repo } = fixture();
  const requested = await request('/api/marketplace/me/deletion', 'POST');
  assert.equal(requested.status, 202);
  assert.equal((await requested.json()).deletion.purgeAfter, '2026-09-28T12:00:00.000Z');
  assert.equal((await (await request('/api/marketplace/me/deletion')).json()).deletion.status, 'pending');
  const unverifiedRecovery = await request(
    '/api/marketplace/me/deletion', 'DELETE', true, undefined, false,
  );
  assert.equal(unverifiedRecovery.status, 403);
  assert.equal((await unverifiedRecovery.json()).error.code, 'email_verification_required');
  assert.equal((await request('/api/marketplace/me/deletion', 'DELETE')).status, 200);
  assert.equal((await request('/api/marketplace/me/deletion', 'DELETE')).status, 409);
  assert.equal((await request('/api/marketplace/me/deletion', 'POST', true, '{}')).status, 400);

  const denied = await api.fetch(new Request(
    'https://pedalboard.test/api/internal/marketplace/purge-deleted-accounts',
  ));
  assert.equal(denied.status, 401);
  const purged = await api.fetch(new Request(
    'https://pedalboard.test/api/internal/marketplace/purge-deleted-accounts',
    { headers: { authorization: 'Bearer cron-secret' } },
  ));
  assert.deepEqual(await purged.json(), { purgedMemberIds: ['member-expired'] });
  assert.deepEqual(repo.calls, [
    'delete:auth-ada', 'status:auth-ada', 'recover:auth-ada', 'recover:auth-ada', 'purge',
  ]);
});
