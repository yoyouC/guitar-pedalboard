import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchMarketplaceAccountDeletion,
  fetchMarketplaceAccountExport,
  MarketplaceAccountClientError,
  recoverMarketplaceAccount,
  requestMarketplaceAccountDeletion,
} from '../src/accounts/client.ts';
import type { MarketplaceAccountExport } from '../shared/account.ts';

const deletion = {
  status: 'pending' as const,
  requestedAt: '2026-08-29T12:00:00.000Z',
  purgeAfter: '2026-09-28T12:00:00.000Z',
};
const exported: MarketplaceAccountExport = {
  formatVersion: 1,
  exportedAt: deletion.requestedAt,
  account: { email: 'ada@example.test' },
  member: {
    id: 'member-ada', handle: 'ada-tones', displayName: 'Ada', bio: '', avatarUrl: null,
    createdAt: deletion.requestedAt, updatedAt: deletion.requestedAt,
  },
  presets: [], collections: [],
  relationships: {
    presetLikes: [], collectionLikes: [], moderationReports: [], moderationAppeals: [],
  },
};

test('account client exports JSON and uses one stable lifecycle endpoint', async () => {
  const calls: Array<{ path: string; method: string }> = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ path, method });
    if (path.endsWith('/export')) {
      return Response.json(exported, {
        headers: { 'content-disposition': 'attachment; filename="export.json"' },
      });
    }
    if (method === 'POST') return Response.json({ deletion }, { status: 202 });
    if (method === 'DELETE') return Response.json({ recovered: true });
    return Response.json({ deletion });
  };

  assert.equal((await fetchMarketplaceAccountExport(fetch)).filename, 'export.json');
  assert.deepEqual(await fetchMarketplaceAccountDeletion(fetch), deletion);
  assert.deepEqual(await requestMarketplaceAccountDeletion(fetch), deletion);
  await recoverMarketplaceAccount(fetch);
  assert.deepEqual(calls, [
    { path: '/api/marketplace/me/export', method: 'GET' },
    { path: '/api/marketplace/me/deletion', method: 'GET' },
    { path: '/api/marketplace/me/deletion', method: 'POST' },
    { path: '/api/marketplace/me/deletion', method: 'DELETE' },
  ]);
});

test('account client rejects malformed export and preserves lifecycle errors', async () => {
  await assert.rejects(
    fetchMarketplaceAccountExport(async () => Response.json({ ...exported, account: { email: 'x', token: 'secret' } })),
    (cause) => cause instanceof MarketplaceAccountClientError && cause.code === 'invalid_account_export',
  );
  await assert.rejects(
    requestMarketplaceAccountDeletion(async () => Response.json({
      error: { code: 'account_deletion_pending', message: 'pending' },
    }, { status: 403 })),
    (cause) => cause instanceof MarketplaceAccountClientError && cause.code === 'account_deletion_pending',
  );
  await assert.rejects(
    recoverMarketplaceAccount(async () => Response.json({ error: {
      code: 'recent_authentication_required', message: 'recent auth required',
      verificationUrl: '/login?return=%2Fsettings%3Fsection%3Daccount',
    } }, { status: 403 })),
    (cause) => cause instanceof MarketplaceAccountClientError
      && cause.code === 'recent_authentication_required'
      && cause.verificationUrl === '/login?return=%2Fsettings%3Fsection%3Daccount',
  );
});
