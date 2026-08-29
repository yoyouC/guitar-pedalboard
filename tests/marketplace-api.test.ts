import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarketplaceApi } from '../server/marketplace/api.ts';
import { createMemoryPublishedPresetRepository } from '../server/marketplace/memoryRepository.ts';
import type { PublishedPreset } from '../shared/marketplace.ts';

const publishedPreset: PublishedPreset = {
  id: 'preset-demo-crunch',
  title: 'Demo Crunch',
  description: 'A reproducible built-in crunch Rig.',
  visibility: 'public',
  creator: {
    id: 'member-system',
    handle: 'guitar-pedalboard',
    displayName: 'Guitar Pedalboard',
  },
  currentRevision: {
    id: 'revision-demo-crunch-1',
    schemaVersion: 5,
    createdAt: '2026-08-29T00:00:00.000Z',
    resourceDependencies: [{ kind: 'builtin' }],
    rig: {
      chain: [],
      amp: {
        categoryId: 'crunch',
        modelKey: 'builtin:crunch',
        enabled: true,
        values: {
          gain: 60,
          bass: 50,
          mid: 65,
          treble: 60,
          presence: 55,
          master: -20.5,
        },
        customName: null,
      },
      cab: {
        id: 'gb4x12',
        ir: { kind: 'builtin', id: 'gb4x12' },
        enabled: true,
        values: { level: -2 },
      },
      preAmpEq: {
        enabled: false,
        bands: {
          hz31_25: 0,
          hz62_5: 0,
          hz125: 0,
          hz250: 0,
          hz500: 0,
          hz1000: 0,
          hz2000: 0,
          hz4000: 0,
          hz8000: 0,
          hz16000: 0,
        },
        levelDb: 0,
      },
      globals: { inputGain: 1, masterVolume: 0.5, bypass: false },
    },
  },
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:00:00.000Z',
};

test('visitor can read a public Published Preset by its stable id', async () => {
  const api = createMarketplaceApi({
    publishedPresets: createMemoryPublishedPresetRepository([publishedPreset]),
  });

  const response = await api.fetch(
    new Request('https://pedalboard.test/api/marketplace/presets/preset-demo-crunch'),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { preset: publishedPreset });
});

test('missing and non-public presets share the same anonymous not-found response', async () => {
  const withdrawnPreset: PublishedPreset = {
    ...publishedPreset,
    id: 'preset-withdrawn',
    visibility: 'withdrawn',
  };
  const api = createMarketplaceApi({
    publishedPresets: createMemoryPublishedPresetRepository([withdrawnPreset]),
  });

  for (const id of ['preset-missing', 'preset-withdrawn']) {
    const response = await api.fetch(
      new Request(`https://pedalboard.test/api/marketplace/presets/${id}`),
    );

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: {
        code: 'published_preset_not_found',
        message: 'Published preset not found',
      },
    });
  }
});

test('repository failure becomes a stable unavailable response', async () => {
  const api = createMarketplaceApi({
    publishedPresets: {
      async findPublicById() {
        throw new Error('database offline');
      },
    },
  });

  const response = await api.fetch(
    new Request('https://pedalboard.test/api/marketplace/presets/preset-demo-crunch'),
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'marketplace_unavailable',
      message: 'Marketplace is temporarily unavailable',
    },
  });
});

test('API refuses a fact-source record containing a local-only resource', async () => {
  const localOnlyPreset: PublishedPreset = {
    ...publishedPreset,
    currentRevision: {
      ...publishedPreset.currentRevision,
      rig: {
        ...publishedPreset.currentRevision.rig,
        cab: {
          id: 'customIr',
          ir: { kind: 'custom', hash: 'local-only-hash' },
          enabled: true,
          values: { level: -2 },
        },
      },
    },
  };
  const api = createMarketplaceApi({
    publishedPresets: createMemoryPublishedPresetRepository([localOnlyPreset]),
  });

  const response = await api.fetch(
    new Request('https://pedalboard.test/api/marketplace/presets/preset-demo-crunch'),
  );

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'marketplace_unavailable');
});
