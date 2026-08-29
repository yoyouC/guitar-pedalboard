import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryPublishedPresetRepository } from '../server/marketplace/memoryRepository.ts';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';
import { createMarketplaceSearchApi } from '../server/search/api.ts';
import { createMemoryMarketplaceDiscoveryRepository } from '../server/search/memoryRepository.ts';
import type { MemberRecord } from '../server/members/repository.ts';
import type { MarketplaceTag, PresetCollection } from '../shared/marketplace.ts';

const rock: MarketplaceTag = {
  id: 'genre-rock', dimension: 'genre', nameZh: '摇滚', nameEn: 'Rock',
};
const now = new Date('2026-08-29T10:00:00.000Z');

function member(id: string, handle: string, displayName: string): MemberRecord {
  return {
    id, authUserId: null, handle, displayName, bio: `${displayName} guitar tones`,
    avatarUrl: null, handleChangedAt: null, createdAt: now, updatedAt: now,
    communityStatus: 'active',
  };
}

function collection(input: {
  id: string;
  title: string;
  creator: MemberRecord;
  visibility: PresetCollection['visibility'];
  createdAt: string;
  itemTitle?: string | null;
}): PresetCollection {
  return {
    id: input.id,
    title: input.title,
    description: 'Stage-ready collection',
    visibility: input.visibility,
    creator: {
      id: input.creator.id,
      handle: input.creator.handle,
      displayName: input.creator.displayName,
    },
    tags: [{ ...rock, aliases: ['arena-code'] }],
    items: input.itemTitle === undefined ? [] : [{
      position: 0,
      presetId: 'preset-secret',
      revisionId: 'revision-secret',
      availability: 'unavailable',
      title: input.itemTitle,
      creator: { id: 'member-secret', handle: 'secret', displayName: 'Secret' },
    }],
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

function fixture() {
  const ada = member('member-ada', 'ada-tones', 'Ada Lovelace');
  const grace = member('member-grace', 'grace-rigs', 'Grace Hopper');
  const discovery = createMemoryMarketplaceDiscoveryRepository({
    collections: [
      collection({
        id: 'collection-public-new', title: 'Rock Stage Two', creator: ada,
        visibility: 'public', createdAt: '2026-08-29T09:00:00.000Z', itemTitle: null,
      }),
      collection({
        id: 'collection-public-old', title: 'Rock Stage One', creator: grace,
        visibility: 'public', createdAt: '2026-08-29T08:00:00.000Z',
      }),
      collection({
        id: 'collection-unlisted', title: 'Secret Stage Text', creator: ada,
        visibility: 'unlisted', createdAt: '2026-08-29T10:00:00.000Z',
        itemTitle: 'Leaked Secret Preset',
      }),
    ],
    members: [ada, grace],
  });
  return createMarketplaceSearchApi({
    presets: createMemoryPublishedPresetRepository([demoPublishedPreset], [rock]),
    discovery,
  });
}

test('unified discovery searches Public collections and creators in separate tabs', async () => {
  const api = fixture();
  const collections = await api.fetch(new Request(
    'https://pedalboard.test/api/marketplace/search/collections?q=rock',
  ));
  const creators = await api.fetch(new Request(
    'https://pedalboard.test/api/marketplace/search/creators?q=lovel',
  ));

  assert.equal(collections.status, 200);
  assert.deepEqual((await collections.json()).items.map((item: { id: string }) => item.id), [
    'collection-public-new',
    'collection-public-old',
  ]);
  assert.equal(creators.status, 200);
  assert.deepEqual((await creators.json()).items.map((item: { id: string }) => item.id), [
    'member-ada',
  ]);

  const alias = await api.fetch(new Request(
    'https://pedalboard.test/api/marketplace/search/collections?q=arena-code',
  ));
  assert.deepEqual((await alias.json()).items.map((item: { id: string }) => item.id), [
    'collection-public-new',
    'collection-public-old',
  ]);
  const author = await api.fetch(new Request(
    'https://pedalboard.test/api/marketplace/search/collections?q=hopper',
  ));
  assert.deepEqual((await author.json()).items.map((item: { id: string }) => item.id), [
    'collection-public-old',
  ]);
});

test('collection discovery excludes Unlisted content and never projects item bodies', async () => {
  const response = await fixture().fetch(new Request(
    'https://pedalboard.test/api/marketplace/search/collections?q=secret',
  ));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.items, []);
  assert.equal(JSON.stringify(body).includes('Leaked Secret Preset'), false);
  assert.equal(JSON.stringify(body).includes('preset-secret'), false);
});

test('collection and creator cursors are stable and cannot be rebound across tabs or queries', async () => {
  const api = fixture();
  const firstResponse = await api.fetch(new Request(
    'https://pedalboard.test/api/marketplace/search/collections?q=rock&limit=1',
  ));
  const first = await firstResponse.json();
  assert.equal(typeof first.nextCursor, 'string');

  const secondResponse = await api.fetch(new Request(
    `https://pedalboard.test/api/marketplace/search/collections?q=rock&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
  ));
  assert.deepEqual((await secondResponse.json()).items.map((item: { id: string }) => item.id), [
    'collection-public-old',
  ]);

  for (const url of [
    `https://pedalboard.test/api/marketplace/search/collections?q=stage&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
    `https://pedalboard.test/api/marketplace/search/creators?q=rock&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
  ]) {
    const rebound = await api.fetch(new Request(url));
    assert.equal(rebound.status, 400);
    assert.equal((await rebound.json()).error.code, 'invalid_search_cursor');
  }
});
