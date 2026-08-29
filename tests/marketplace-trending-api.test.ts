import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarketplaceLikesApi } from '../server/likes/api.ts';
import { createMemoryMarketplaceLikeRepository } from '../server/likes/memoryRepository.ts';
import { createMemoryMarketplaceTrendingRepository } from '../server/trending/memoryRepository.ts';
import { createMemoryMemberRepository } from '../server/members/memoryRepository.ts';
import {
  DEFAULT_MARKETPLACE_TRENDING_POLICY,
  parseMarketplaceTrendingPolicy,
} from '../server/trending/policy.ts';
import { createMarketplaceTrendingRebuildApi } from '../server/trending/rebuildApi.ts';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';
import type { CanonicalPublishedPreset, PresetCollection } from '../shared/marketplace.ts';

const presetA = structuredClone(demoPublishedPreset);
const presetB: CanonicalPublishedPreset = {
  ...structuredClone(demoPublishedPreset), id: 'preset-trending-b', title: 'Trending B',
  currentRevision: {
    ...structuredClone(demoPublishedPreset.currentRevision), id: 'revision-trending-b',
  },
};
const collection: PresetCollection = {
  id: 'collection-trending-a', title: 'Trending Collection', description: '', visibility: 'public',
  creator: { id: 'member-curator', handle: 'curator', displayName: 'Curator' },
  tags: demoPublishedPreset.tags, items: [],
  createdAt: '2026-08-29T00:00:00.000Z', updatedAt: '2026-08-29T00:00:00.000Z',
};
const now = new Date('2026-08-29T12:00:00.000Z');

function fixture() {
  const bannedMemberIds = new Set<string>();
  const repository = createMemoryMarketplaceLikeRepository({
    presets: [presetA, presetB], collections: [collection],
  });
  const trending = createMemoryMarketplaceTrendingRepository({
    presets: [presetA, presetB], collections: [collection],
    likes: repository, bannedMemberIds,
  });
  const api = createMarketplaceLikesApi({
    repository,
    trending,
    sessions: { async verify() { return null; } },
    members: createMemoryMemberRepository([]),
    now: () => now,
    createMemberId: () => 'unused',
    createHandleSuffix: () => 'unused',
  });
  const get = (path: string) => api.fetch(new Request(`https://pedalboard.test${path}`));
  return { bannedMemberIds, get, repository, trending };
}

test('Trending separates target kinds and favors recent explicit likes over more old likes', async () => {
  const { get, repository, trending } = fixture();
  await repository.setLiked({
    kind: 'preset', targetId: presetA.id, memberId: 'member-ada', liked: true,
    now: new Date(now.getTime() - 60 * 60_000),
  });
  assert.equal((await repository.getState('preset', presetA.id, 'member-ada')).liked, true);
  assert.deepEqual((await (await get('/api/marketplace/trending/presets')).json()).items, []);
  for (const memberId of ['member-ada', 'member-bob']) {
    await repository.setLiked({
      kind: 'preset', targetId: presetB.id, memberId, liked: true,
      now: new Date(now.getTime() - 6 * 24 * 60 * 60_000),
    });
  }
  await repository.setLiked({
    kind: 'collection', targetId: collection.id, memberId: 'member-ada', liked: true,
    now: new Date(now.getTime() - 2 * 60 * 60_000),
  });
  await trending.rebuild({ now, policy: DEFAULT_MARKETPLACE_TRENDING_POLICY });

  const presets = await (await get('/api/marketplace/trending/presets')).json();
  assert.deepEqual(presets.items.map((item: { id: string }) => item.id), [presetA.id, presetB.id]);
  assert.equal(JSON.stringify(presets).includes('trendScore'), false);
  assert.equal(JSON.stringify(presets).includes('view'), false);
  assert.deepEqual(
    (await (await get('/api/marketplace/trending/collections')).json()).items
      .map((item: { id: string }) => item.id),
    [collection.id],
  );
});

test('Trending snapshots paginate stably while cancellation and bans affect the next rebuild', async () => {
  const { bannedMemberIds, get, repository, trending } = fixture();
  await repository.setLiked({
    kind: 'preset', targetId: presetA.id, memberId: 'member-ada', liked: true,
    now: new Date(now.getTime() - 60 * 60_000),
  });
  await repository.setLiked({
    kind: 'preset', targetId: presetB.id, memberId: 'member-bob', liked: true,
    now: new Date(now.getTime() - 2 * 60 * 60_000),
  });
  await trending.rebuild({ now, policy: DEFAULT_MARKETPLACE_TRENDING_POLICY });
  const first = await (await get('/api/marketplace/trending/presets?limit=1')).json();
  assert.deepEqual(first.items.map((item: { id: string }) => item.id), [presetA.id]);
  assert.equal(typeof first.nextCursor, 'string');

  await repository.setLiked({
    kind: 'preset', targetId: presetB.id, memberId: 'member-bob', liked: false, now,
  });
  await trending.rebuild({ now, policy: DEFAULT_MARKETPLACE_TRENDING_POLICY });
  const oldSecond = await (await get(
    `/api/marketplace/trending/presets?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
  )).json();
  assert.deepEqual(oldSecond.items.map((item: { id: string }) => item.id), [presetB.id]);
  assert.deepEqual(
    (await (await get('/api/marketplace/trending/presets')).json()).items
      .map((item: { id: string }) => item.id),
    [presetA.id],
  );

  bannedMemberIds.add('member-ada');
  await trending.rebuild({ now, policy: DEFAULT_MARKETPLACE_TRENDING_POLICY });
  assert.deepEqual((await (await get('/api/marketplace/trending/presets')).json()).items, []);
});

test('Trending rejects behavioral query signals and cursors bound to another list shape', async () => {
  const { get, repository, trending } = fixture();
  await repository.setLiked({
    kind: 'preset', targetId: presetA.id, memberId: 'member-ada', liked: true, now,
  });
  await repository.setLiked({
    kind: 'preset', targetId: presetB.id, memberId: 'member-bob', liked: true, now,
  });
  await trending.rebuild({ now, policy: DEFAULT_MARKETPLACE_TRENDING_POLICY });
  assert.equal((await get('/api/marketplace/trending/presets?views=99')).status, 400);
  const first = await (await get('/api/marketplace/trending/presets?limit=1')).json();
  assert.equal((await get(
    `/api/marketplace/trending/collections?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
  )).status, 400);
});

test('Trending rebuild endpoint requires its dedicated scheduler secret', async () => {
  let rebuilds = 0;
  const api = createMarketplaceTrendingRebuildApi({
    secret: 'scheduler-secret-value',
    now: () => now,
    async rebuild(receivedNow) {
      assert.equal(receivedNow, now);
      rebuilds += 1;
    },
  });
  assert.equal((await api.fetch(new Request('https://pedalboard.test/internal'))).status, 401);
  const response = await api.fetch(new Request('https://pedalboard.test/internal', {
    headers: { authorization: 'Bearer scheduler-secret-value' },
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { rebuiltAt: now.toISOString() });
  assert.equal(rebuilds, 1);

  const unconfigured = createMarketplaceTrendingRebuildApi({
    secret: undefined, now: () => now, async rebuild() {},
  });
  assert.equal((await unconfigured.fetch(new Request('https://pedalboard.test/internal'))).status, 503);
});

test('Trending deployment policy accepts bounded tuning without exposing it through the list API', () => {
  assert.deepEqual(parseMarketplaceTrendingPolicy({
    MARKETPLACE_TRENDING_WINDOW_HOURS: '72',
    MARKETPLACE_TRENDING_HALF_LIFE_HOURS: '12',
  }), { windowHours: 72, halfLifeHours: 12 });
  assert.deepEqual(parseMarketplaceTrendingPolicy({
    MARKETPLACE_TRENDING_WINDOW_HOURS: '0',
    MARKETPLACE_TRENDING_HALF_LIFE_HOURS: 'not-a-number',
  }), DEFAULT_MARKETPLACE_TRENDING_POLICY);
});
