import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarketplaceLikesApi } from '../server/likes/api.ts';
import { createMemoryMarketplaceLikeRepository } from '../server/likes/memoryRepository.ts';
import { createMemoryMarketplaceTrendingRepository } from '../server/trending/memoryRepository.ts';
import { createMemoryMemberRepository } from '../server/members/memoryRepository.ts';
import type { AuthenticatedIdentity } from '../server/auth/session.ts';
import type { CanonicalPublishedPreset, PresetCollection } from '../shared/marketplace.ts';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';

const presetA = structuredClone(demoPublishedPreset);
const presetB: CanonicalPublishedPreset = {
  ...structuredClone(demoPublishedPreset),
  id: 'preset-b',
  title: 'Preset B',
  currentRevision: { ...structuredClone(demoPublishedPreset.currentRevision), id: 'revision-b' },
};
const unlistedPreset: CanonicalPublishedPreset = {
  ...structuredClone(presetB), id: 'preset-unlisted-like', visibility: 'unlisted',
  currentRevision: { ...structuredClone(presetB.currentRevision), id: 'revision-unlisted-like' },
};
const hiddenPreset: CanonicalPublishedPreset = {
  ...structuredClone(presetB), id: 'preset-hidden-like', visibility: 'hidden',
  currentRevision: { ...structuredClone(presetB.currentRevision), id: 'revision-hidden-like' },
};
const collection: PresetCollection = {
  id: 'collection-a', title: 'Collection A', description: '', visibility: 'public',
  creator: { id: 'member-curator', handle: 'curator', displayName: 'Curator' },
  tags: demoPublishedPreset.tags, items: [],
  createdAt: '2026-08-29T00:00:00.000Z', updatedAt: '2026-08-29T00:00:00.000Z',
};

const identities: Record<string, AuthenticatedIdentity> = {
  ada: { authUserId: 'auth-ada', email: 'ada@example.test', displayName: 'Ada', avatarUrl: null },
  bob: { authUserId: 'auth-bob', email: 'bob@example.test', displayName: 'Bob', avatarUrl: null },
  owner: {
    authUserId: 'auth-owner', email: 'owner@example.test',
    displayName: demoPublishedPreset.creator.displayName, avatarUrl: null,
  },
};

function fixture() {
  const repository = createMemoryMarketplaceLikeRepository({
    presets: [presetA, presetB, unlistedPreset, hiddenPreset], collections: [collection],
  });
  const trending = createMemoryMarketplaceTrendingRepository({
    presets: [presetA, presetB, unlistedPreset, hiddenPreset], collections: [collection],
    likes: repository,
  });
  const members = createMemoryMemberRepository([
    {
      id: 'member-ada', authUserId: 'auth-ada', handle: 'ada', displayName: 'Ada', bio: '',
      avatarUrl: null, handleChangedAt: null, createdAt: new Date(0), updatedAt: new Date(0),
    },
    {
      id: 'member-bob', authUserId: 'auth-bob', handle: 'bob', displayName: 'Bob', bio: '',
      avatarUrl: null, handleChangedAt: null, createdAt: new Date(0), updatedAt: new Date(0),
    },
    {
      id: presetA.creator.id, authUserId: 'auth-owner', handle: presetA.creator.handle,
      displayName: presetA.creator.displayName, bio: '', avatarUrl: null, handleChangedAt: null,
      createdAt: new Date(0), updatedAt: new Date(0),
    },
  ]);
  let tick = 0;
  const api = createMarketplaceLikesApi({
    repository,
    trending,
    sessions: {
      async verify(request) { return identities[request.headers.get('x-user') ?? ''] ?? null; },
    },
    members,
    now: () => new Date(Date.UTC(2026, 7, 29, 10, 0, tick++)),
    createMemberId: () => 'member-created',
    createHandleSuffix: () => 'created1',
  });
  const request = (path: string, method = 'GET', user?: string, body?: string) => api.fetch(new Request(
    `https://pedalboard.test${path}`,
    { method, headers: user ? { 'x-user': user } : undefined, body },
  ));
  return { repository, request };
}

test('like writes are authenticated, idempotent, cancellable, and reject self/count forgery', async () => {
  const { request } = fixture();
  const path = `/api/marketplace/likes/presets/${presetA.id}`;
  assert.equal((await request(path, 'PUT')).status, 401);
  assert.equal((await request(path, 'PUT', 'owner')).status, 403);
  assert.equal((await request(path, 'PUT', 'ada', '{"likeCount":999}')).status, 400);
  assert.equal((await request(`/api/marketplace/likes/presets/${hiddenPreset.id}`, 'PUT', 'ada')).status, 404);
  assert.equal((await request(`/api/marketplace/likes/presets/${unlistedPreset.id}`, 'PUT', 'ada')).status, 200);

  assert.equal((await request(path, 'PUT', 'ada')).status, 200);
  assert.equal((await request(path, 'PUT', 'ada')).status, 200);
  assert.deepEqual(await (await request(path, 'GET', 'ada')).json(), {
    state: { liked: true, canLike: true, likeCount: 1 },
  });
  assert.equal((await request(path, 'DELETE', 'ada')).status, 200);
  assert.equal((await request(path, 'DELETE', 'ada')).status, 200);
  assert.equal((await (await request(path, 'GET', 'ada')).json()).state.likeCount, 0);
});

test('my likes are private, separate both target kinds, and never appear on public ranking rows', async () => {
  const { request } = fixture();
  await request(`/api/marketplace/likes/presets/${presetA.id}`, 'PUT', 'ada');
  await request(`/api/marketplace/likes/collections/${collection.id}`, 'PUT', 'ada');

  assert.equal((await request('/api/marketplace/me/likes')).status, 401);
  const mine = await (await request('/api/marketplace/me/likes', 'GET', 'ada')).json();
  assert.deepEqual(mine.likes.presets.map((item: { id: string }) => item.id), [presetA.id]);
  assert.deepEqual(mine.likes.collections.map((item: { id: string }) => item.id), [collection.id]);
  assert.deepEqual(await (await request('/api/marketplace/me/likes', 'GET', 'bob')).json(), {
    likes: { presets: [], collections: [] },
  });
  const popular = await (await request('/api/marketplace/popular/presets')).json();
  assert.equal(JSON.stringify(popular).includes('member-ada'), false);
  assert.equal(JSON.stringify(popular).includes('likedAt'), false);
});

test('preset and collection Popular pages use independent counts and stable count/id cursors', async () => {
  const { request } = fixture();
  await request(`/api/marketplace/likes/presets/${presetA.id}`, 'PUT', 'ada');
  await request(`/api/marketplace/likes/presets/${presetA.id}`, 'PUT', 'bob');
  await request(`/api/marketplace/likes/presets/${presetB.id}`, 'PUT', 'ada');
  await request(`/api/marketplace/likes/collections/${collection.id}`, 'PUT', 'ada');

  const first = await (await request('/api/marketplace/popular/presets?limit=1')).json();
  assert.deepEqual(first.items.map((item: { id: string; likeCount: number }) => (
    [item.id, item.likeCount]
  )), [[presetA.id, 2]]);
  assert.equal(typeof first.nextCursor, 'string');
  await request(`/api/marketplace/likes/presets/${presetA.id}`, 'DELETE', 'bob');
  await request(`/api/marketplace/likes/presets/${presetB.id}`, 'PUT', 'bob');
  const second = await (await request(
    `/api/marketplace/popular/presets?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
  )).json();
  assert.deepEqual(second.items.map((item: { id: string; likeCount: number }) => (
    [item.id, item.likeCount]
  )), [[presetB.id, 1]]);
  await request(`/api/marketplace/likes/presets/${presetB.id}`, 'DELETE', 'bob');
  const tied = await (await request('/api/marketplace/popular/presets')).json();
  assert.deepEqual(tied.items.map((item: { id: string }) => item.id), [presetA.id, presetB.id]);
  const collections = await (await request('/api/marketplace/popular/collections')).json();
  assert.deepEqual(collections.items.map((item: { id: string; likeCount: number }) => (
    [item.id, item.likeCount]
  )), [[collection.id, 1]]);
});
