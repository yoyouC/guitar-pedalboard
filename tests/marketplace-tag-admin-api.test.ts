import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuthenticatedIdentity } from '../server/auth/session.ts';
import { createMarketplaceTagAdministrationApi } from '../server/tags/api.ts';
import { createMemoryMarketplaceTagAdministrationRepository } from '../server/tags/memoryRepository.ts';

const identities: Record<string, AuthenticatedIdentity> = {
  member: { authUserId: 'auth-member', email: 'member@example.test', displayName: 'Member', avatarUrl: null },
  admin: { authUserId: 'auth-admin', email: 'admin@example.test', displayName: 'Admin', avatarUrl: null },
};

function fixture(options: Parameters<typeof createMemoryMarketplaceTagAdministrationRepository>[0] = {}) {
  const repository = createMemoryMarketplaceTagAdministrationRepository({
    tags: options.tags ?? [{
      id: 'genre-rock', dimension: 'genre', nameZh: '摇滚', nameEn: 'Rock',
      aliases: ['rock'], status: 'active', mergedIntoId: null,
    }],
    presetTagIds: options.presetTagIds,
    collectionTagIds: options.collectionTagIds,
  });
  let id = 0;
  const api = createMarketplaceTagAdministrationApi({
    repository,
    sessions: {
      async verify(request) { return identities[request.headers.get('x-user') ?? ''] ?? null; },
    },
    adminAuthUserIds: new Set(['auth-admin']),
    now: () => new Date('2026-08-29T16:00:00.000Z'),
    createAuditId: () => `tag-audit-${++id}`,
  });
  const request = (path: string, method = 'GET', user?: string, body?: unknown) => api.fetch(new Request(
    `https://pedalboard.test${path}`,
    {
      method,
      headers: user ? { 'x-user': user, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  ));
  return { request };
}

test('only administrators can create a stable bilingual controlled Tag', async () => {
  const { request } = fixture();
  const body = {
    id: 'mood-dreamy', dimension: 'mood', nameZh: '梦幻', nameEn: 'Dreamy',
    aliases: ['ambient'], reason: 'Add the approved mood vocabulary.',
  };
  assert.equal((await request('/api/marketplace/admin/tags', 'POST', undefined, body)).status, 401);
  assert.equal((await request('/api/marketplace/admin/tags', 'POST', 'member', body)).status, 403);
  assert.equal((await request('/api/marketplace/admin/tags', 'POST', 'admin', body)).status, 201);

  const response = await request('/api/marketplace/admin/tags', 'GET', 'admin');
  assert.equal(response.status, 200);
  const tags = (await response.json()).tags;
  assert.deepEqual(tags.find((tag: { id: string }) => tag.id === 'mood-dreamy'), {
    id: 'mood-dreamy', dimension: 'mood', nameZh: '梦幻', nameEn: 'Dreamy',
    aliases: ['ambient'], status: 'active', mergedIntoId: null,
    presetCount: 0, collectionCount: 0,
  });
});

test('administrator edits and deprecates a Tag without deleting its identity', async () => {
  const { request } = fixture();
  assert.equal((await request('/api/marketplace/admin/tags/genre-rock', 'PATCH', 'admin', {
    dimension: 'genre', nameZh: '摇滚乐', nameEn: 'Rock Music', aliases: ['rock', 'rock music'],
    reason: 'Clarify the public vocabulary.',
  })).status, 200);
  assert.equal((await request('/api/marketplace/admin/tags/genre-rock/deprecate', 'POST', 'admin', {
    reason: 'Use a more specific genre Tag for future publications.',
  })).status, 200);

  const tags = (await (await request('/api/marketplace/admin/tags', 'GET', 'admin')).json()).tags;
  assert.deepEqual(tags[0], {
    id: 'genre-rock', dimension: 'genre', nameZh: '摇滚乐', nameEn: 'Rock Music',
    aliases: ['rock', 'rock music'], status: 'deprecated', mergedIntoId: null,
    presetCount: 0, collectionCount: 0,
  });
  const audit = (await (await request('/api/marketplace/admin/tags/audit', 'GET', 'admin')).json()).entries;
  assert.deepEqual(audit.map((entry: { action: string }) => entry.action), ['edit_tag', 'deprecate_tag']);
});

test('Tag merge migrates usages and aliases atomically and is safe to retry', async () => {
  const { request } = fixture({
    tags: [
      { id: 'genre-rock', dimension: 'genre', nameZh: '摇滚', nameEn: 'Rock', aliases: ['rock'], status: 'active', mergedIntoId: null },
      { id: 'genre-alt-rock', dimension: 'genre', nameZh: '另类摇滚', nameEn: 'Alternative Rock', aliases: ['alt rock'], status: 'active', mergedIntoId: null },
    ],
    presetTagIds: new Map([
      ['preset-one', ['genre-rock']],
      ['preset-two', ['genre-rock', 'genre-alt-rock']],
    ]),
    collectionTagIds: new Map([['collection-one', ['genre-rock']]]),
  });
  const merge = {
    targetId: 'genre-alt-rock', reason: 'Consolidate duplicate genre vocabulary.',
  };
  assert.equal((await request('/api/marketplace/admin/tags/genre-rock/merge', 'POST', 'admin', merge)).status, 200);
  assert.equal((await request('/api/marketplace/admin/tags/genre-rock/merge', 'POST', 'admin', merge)).status, 200);

  const tags = (await (await request('/api/marketplace/admin/tags', 'GET', 'admin')).json()).tags;
  const source = tags.find((tag: { id: string }) => tag.id === 'genre-rock');
  const target = tags.find((tag: { id: string }) => tag.id === 'genre-alt-rock');
  assert.deepEqual(source, {
    id: 'genre-rock', dimension: 'genre', nameZh: '摇滚', nameEn: 'Rock', aliases: ['rock'],
    status: 'merged', mergedIntoId: 'genre-alt-rock', presetCount: 0, collectionCount: 0,
  });
  assert.deepEqual(target, {
    id: 'genre-alt-rock', dimension: 'genre', nameZh: '另类摇滚', nameEn: 'Alternative Rock',
    aliases: ['alt rock', 'rock', '摇滚', 'genre-rock'], status: 'active', mergedIntoId: null,
    presetCount: 2, collectionCount: 1,
  });
  const audit = (await (await request('/api/marketplace/admin/tags/audit', 'GET', 'admin')).json()).entries;
  assert.equal(audit.filter((entry: { action: string }) => entry.action === 'merge_tag').length, 1);
});
