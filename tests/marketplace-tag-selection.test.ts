import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarketplaceApi } from '../server/marketplace/api.ts';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';
import { createMemoryPublishedPresetRepository } from '../server/marketplace/memoryRepository.ts';
import { createMarketplaceSearchApi } from '../server/search/api.ts';
import { createMemoryMarketplaceDiscoveryRepository } from '../server/search/memoryRepository.ts';
import { createMemoryPresetCollectionRepository } from '../server/collections/memoryRepository.ts';
import { createMemoryMarketplaceTagAdministrationRepository } from '../server/tags/memoryRepository.ts';

const searchInput = (tagIds: string[], text = '') => ({
  text, tagIds, pedalIds: [], ampIds: [], cabIds: [], resourceKinds: [],
  resourceDependencyKeys: [], publishedAfter: null, publishedBefore: null,
  limit: 20, cursor: null,
});

test('public Tag selection hides deprecated identities while old ids and existing content remain readable', async () => {
  const legacy = {
    ...structuredClone(demoPublishedPreset),
    id: 'preset-legacy-rock',
    tags: [{ id: 'genre-rock', dimension: 'genre', nameZh: '摇滚', nameEn: 'Rock' }],
    currentRevision: { ...structuredClone(demoPublishedPreset.currentRevision), id: 'revision-legacy-rock' },
  };
  const canonical = {
    ...structuredClone(demoPublishedPreset),
    id: 'preset-alt-rock',
    tags: [{ id: 'genre-alt-rock', dimension: 'genre', nameZh: '另类摇滚', nameEn: 'Alternative Rock' }],
    currentRevision: { ...structuredClone(demoPublishedPreset.currentRevision), id: 'revision-alt-rock' },
  };
  const repository = createMemoryPublishedPresetRepository([legacy, canonical], [
    { id: 'genre-rock', dimension: 'genre', nameZh: '摇滚', nameEn: 'Rock', aliases: ['rock'], status: 'merged', mergedIntoId: 'genre-alt-rock' },
    { id: 'genre-alt-rock', dimension: 'genre', nameZh: '另类摇滚', nameEn: 'Alternative Rock', aliases: ['alt rock', 'rock'], status: 'active', mergedIntoId: null },
    { id: 'mood-dreamy', dimension: 'mood', nameZh: '梦幻', nameEn: 'Dreamy', aliases: [], status: 'deprecated', mergedIntoId: null },
  ]);
  const publicApi = createMarketplaceApi({ publishedPresets: repository, availableTags: repository });
  const searchApi = createMarketplaceSearchApi({ presets: repository });

  const tags = await (await publicApi.fetch(new Request('https://pedalboard.test/api/marketplace/tags'))).json();
  assert.deepEqual(tags.tags.map((tag: { id: string }) => tag.id), ['genre-alt-rock']);
  const existing = await publicApi.fetch(new Request('https://pedalboard.test/api/marketplace/presets/preset-legacy-rock'));
  assert.equal(existing.status, 200);
  assert.equal((await existing.json()).preset.tags[0].id, 'genre-rock');
  const result = await (await searchApi.fetch(new Request(
    'https://pedalboard.test/api/marketplace/search/presets?tag=genre-rock',
  ))).json();
  assert.deepEqual(result.items.map((item: { id: string }) => item.id), ['preset-alt-rock']);
});

test('shared memory adapters apply Tag lifecycle changes across development APIs', async () => {
  const tags = [
    { id: 'tone-crunch', dimension: 'tone', nameZh: 'Crunch', nameEn: 'Crunch', aliases: ['crunch tone'], status: 'active' as const, mergedIntoId: null },
    { id: 'tone-drive', dimension: 'tone', nameZh: '驱动', nameEn: 'Drive', aliases: [], status: 'active' as const, mergedIntoId: null },
  ];
  const preset = structuredClone(demoPublishedPreset);
  const publications = createMemoryPublishedPresetRepository([preset], tags);
  const collections = createMemoryPresetCollectionRepository([{
    id: 'collection-crunch', title: 'Crunch set', description: '', visibility: 'public',
    creator: structuredClone(preset.creator), tags: structuredClone(preset.tags), items: [],
    createdAt: preset.createdAt, updatedAt: preset.updatedAt,
  }], publications, tags);
  const administration = createMemoryMarketplaceTagAdministrationRepository({
    tags,
    bindings: {
      presetTagIds: () => publications.snapshotTagAssignments(),
      collectionTagIds: () => collections.snapshotTagAssignments(),
      synchronizeTags(next) {
        publications.synchronizeManagedTags(next);
        collections.synchronizeManagedTags(next);
      },
    },
  });

  await administration.apply({
    action: 'merge', tagId: 'tone-crunch', targetId: 'tone-drive',
    auditId: 'audit-memory-merge', actorAuthUserId: 'auth-admin', reason: 'Merge in dev.',
    now: new Date('2026-08-29T18:00:00.000Z'),
  });
  assert.deepEqual((await publications.listAvailableTags()).map((tag) => tag.id), ['tone-drive']);
  assert.deepEqual((await collections.findVisibleById('collection-crunch'))?.tags.map((tag) => tag.id), ['tone-drive']);
  assert.deepEqual(
    (await publications.searchPublicPresets(searchInput(['tone-crunch']))).items.map((item) => item.id),
    [preset.id],
  );

  await administration.apply({
    action: 'edit', tagId: 'tone-drive',
    tag: { dimension: 'tone', nameZh: '驱动', nameEn: 'Drive', aliases: [] },
    auditId: 'audit-memory-edit', actorAuthUserId: 'auth-admin', reason: 'Edit in dev.',
    now: new Date('2026-08-29T18:00:30.000Z'),
  });
  assert.deepEqual(
    (await publications.searchPublicPresets(searchInput([], 'crunch tone'))).items.map((item) => item.id),
    [preset.id],
  );
  const discovery = createMemoryMarketplaceDiscoveryRepository({
    collections: () => collections.listForDiscovery(), members: [],
  });
  assert.deepEqual(
    (await discovery.searchPublicCollections({
      text: 'crunch tone', limit: 20, cursor: null,
    })).items.map((item) => item.id),
    ['collection-crunch'],
  );

  await administration.apply({
    action: 'deprecate', tagId: 'tone-drive',
    auditId: 'audit-memory-deprecate', actorAuthUserId: 'auth-admin', reason: 'Deprecate in dev.',
    now: new Date('2026-08-29T18:01:00.000Z'),
  });
  assert.deepEqual(await publications.listAvailableTags(), []);
  assert.deepEqual(await collections.listAvailableTags(), []);
});
