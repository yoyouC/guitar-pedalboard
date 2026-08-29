import assert from 'node:assert/strict';
import test from 'node:test';
import { createPresetCollectionApi } from '../server/collections/api.ts';
import { createMemoryPresetCollectionRepository } from '../server/collections/memoryRepository.ts';
import { createMemoryPublishedPresetRepository } from '../server/marketplace/memoryRepository.ts';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';
import type { MarketplaceTag, PresetCollection } from '../shared/marketplace.ts';

const tags: MarketplaceTag[] = [
  { id: 'genre-rock', dimension: 'genre', nameZh: '摇滚', nameEn: 'Rock' },
];

const collection: PresetCollection = {
  id: 'collection-stage-tones',
  title: 'Stage Tones',
  description: 'Fixed sounds for one set.',
  visibility: 'public',
  creator: { id: 'member-curator', handle: 'curator', displayName: 'Curator' },
  tags,
  items: [{
    position: 0,
    presetId: demoPublishedPreset.id,
    revisionId: demoPublishedPreset.currentRevision.id,
    availability: 'available',
    title: demoPublishedPreset.title,
    creator: demoPublishedPreset.creator,
  }],
  createdAt: '2026-08-29T08:00:00.000Z',
  updatedAt: '2026-08-29T08:00:00.000Z',
};

test('visitor reads a public collection whose items pin exact revisions and original creators', async () => {
  const presets = createMemoryPublishedPresetRepository([demoPublishedPreset], tags);
  const collections = createMemoryPresetCollectionRepository([collection], presets, tags);
  const api = createPresetCollectionApi({ collections });

  const first = await api.fetch(new Request(
    'https://pedalboard.test/api/marketplace/collections/collection-stage-tones',
  ));
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { collection });

  await presets.appendRevision({
    presetId: demoPublishedPreset.id,
    creatorId: demoPublishedPreset.creator.id,
    revisionId: 'revision-demo-crunch-2',
    schemaVersion: demoPublishedPreset.currentRevision.schemaVersion,
    rig: {
      ...demoPublishedPreset.currentRevision.rig,
      globals: { ...demoPublishedPreset.currentRevision.rig.globals, masterVolume: 0.8 },
    },
    resourceDependencies: demoPublishedPreset.currentRevision.resourceDependencies,
    derivedAttributes: demoPublishedPreset.derivedAttributes,
    expectedUpdatedAt: new Date(demoPublishedPreset.updatedAt),
    now: new Date('2026-08-29T09:00:00.000Z'),
  });

  const afterSourceUpdate = await api.fetch(new Request(
    'https://pedalboard.test/api/marketplace/collections/collection-stage-tones',
  ));
  const body = await afterSourceUpdate.json();
  assert.equal(body.collection.items[0].revisionId, demoPublishedPreset.currentRevision.id);
  assert.equal(body.collection.items[0].creator.id, demoPublishedPreset.creator.id);
});

test('withdrawn source remains an attribution-only unavailable placeholder', async () => {
  const presets = createMemoryPublishedPresetRepository([demoPublishedPreset], tags);
  const collections = createMemoryPresetCollectionRepository([collection], presets, tags);
  const api = createPresetCollectionApi({ collections });

  await presets.updateVisibility({
    presetId: demoPublishedPreset.id,
    creatorId: demoPublishedPreset.creator.id,
    visibility: 'withdrawn',
    expectedUpdatedAt: new Date(demoPublishedPreset.updatedAt),
    now: new Date('2026-08-29T09:00:00.000Z'),
  });

  const response = await api.fetch(new Request(
    'https://pedalboard.test/api/marketplace/collections/collection-stage-tones',
  ));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.collection.items[0], {
    position: 0,
    presetId: demoPublishedPreset.id,
    revisionId: demoPublishedPreset.currentRevision.id,
    availability: 'unavailable',
    title: null,
    creator: demoPublishedPreset.creator,
  });
  assert.equal(JSON.stringify(body).includes('rig'), false);
  assert.equal(JSON.stringify(body).includes('resourceDependencies'), false);
});

test('moderator-hidden source is projected through the same unavailable placeholder', async () => {
  const hiddenPreset = { ...structuredClone(demoPublishedPreset), visibility: 'hidden' as const };
  const presets = createMemoryPublishedPresetRepository([hiddenPreset], tags);
  const collections = createMemoryPresetCollectionRepository([collection], presets, tags);
  const response = await createPresetCollectionApi({ collections }).fetch(new Request(
    'https://pedalboard.test/api/marketplace/collections/collection-stage-tones',
  ));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.collection.items[0].availability, 'unavailable');
  assert.equal(body.collection.items[0].title, null);
  assert.equal(body.collection.items[0].creator.id, hiddenPreset.creator.id);
  assert.equal(JSON.stringify(body).includes('rig'), false);
});
