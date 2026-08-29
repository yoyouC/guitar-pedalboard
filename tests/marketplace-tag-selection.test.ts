import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarketplaceApi } from '../server/marketplace/api.ts';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';
import { createMemoryPublishedPresetRepository } from '../server/marketplace/memoryRepository.ts';
import { createMarketplaceSearchApi } from '../server/search/api.ts';

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
