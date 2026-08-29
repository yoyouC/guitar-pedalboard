import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarketplaceApi } from '../server/marketplace/api.ts';
import { createMemoryPublishedPresetRepository } from '../server/marketplace/memoryRepository.ts';
import { createMemoryMemberRepository } from '../server/members/memoryRepository.ts';
import type { MarketplaceTag, PublishedPreset } from '../shared/marketplace.ts';
import type { AuthenticatedIdentity } from '../server/auth/session.ts';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';

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
  tags: demoPublishedPreset.tags,
  derivedAttributes: demoPublishedPreset.derivedAttributes,
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

const controlledTags: MarketplaceTag[] = [
  { id: 'tone-crunch', dimension: 'tone', nameZh: 'Crunch', nameEn: 'Crunch' },
  { id: 'genre-rock', dimension: 'genre', nameZh: '摇滚', nameEn: 'Rock' },
];

const adaIdentity: AuthenticatedIdentity = {
  authUserId: 'auth-ada',
  email: 'ada@example.test',
  displayName: 'Ada',
  avatarUrl: null,
};

function publicationApi(
  repository = createMemoryPublishedPresetRepository([], controlledTags),
  identity: AuthenticatedIdentity | null = adaIdentity,
) {
  return {
    repository,
    api: createMarketplaceApi({
      publishedPresets: repository,
      publication: {
        repository,
        sessions: { async verify() { return identity; } },
        members: createMemoryMemberRepository(),
        now: () => new Date('2026-08-29T10:00:00.000Z'),
        createPresetId: () => 'preset-ada-crunch',
        createRevisionId: () => 'revision-ada-crunch-1',
        createMemberId: () => 'member-ada',
        createHandleSuffix: () => 'ada00001',
      },
    }),
  };
}

function publishRequest(extra: Record<string, unknown> = {}) {
  return new Request('https://pedalboard.test/api/marketplace/presets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Ada Crunch',
      description: 'A plain-text crunch Rig.',
      tagIds: ['tone-crunch', 'genre-rock'],
      schemaVersion: 5,
      rig: publishedPreset.currentRevision.rig,
      ...extra,
    }),
  });
}

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

test('verified member atomically publishes the first immutable revision with server ownership', async () => {
  const { api, repository } = publicationApi();

  const response = await api.fetch(publishRequest());
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.preset.id, 'preset-ada-crunch');
  assert.equal(body.preset.creator.id, 'member-ada');
  assert.equal(body.preset.currentRevision.id, 'revision-ada-crunch-1');
  assert.deepEqual(body.preset.tags.map((tag: MarketplaceTag) => tag.id), [
    'tone-crunch',
    'genre-rock',
  ]);
  assert.deepEqual(body.preset.currentRevision.resourceDependencies, [{ kind: 'builtin' }]);
  assert.equal(await repository.count(), 1);
});

test('publication rejects anonymous and forged ownership without leaving a work', async () => {
  const anonymous = publicationApi(undefined, null);
  const anonymousResponse = await anonymous.api.fetch(publishRequest());
  assert.equal(anonymousResponse.status, 401);
  assert.equal(await anonymous.repository.count(), 0);

  const forged = publicationApi();
  const forgedResponse = await forged.api.fetch(publishRequest({
    ownerId: 'member-someone-else',
    likeCount: 9001,
    rank: 1,
  }));
  assert.equal(forgedResponse.status, 400);
  assert.equal((await forgedResponse.json()).error.code, 'invalid_publication');
  assert.equal(await forged.repository.count(), 0);
});

test('schema, metadata, tag, and local-resource failures leave no partial publication', async () => {
  const cases = [
    { title: 'x'.repeat(81) },
    { tagIds: [] },
    { tagIds: ['missing-tag'] },
    { schemaVersion: 999 },
    {
      rig: {
        ...publishedPreset.currentRevision.rig,
        amp: {
          ...publishedPreset.currentRevision.rig.amp,
          modelKey: 'nam-wasm:custom',
          customName: 'local.nam',
        },
      },
    },
  ];

  for (const invalid of cases) {
    const { api, repository } = publicationApi();
    const response = await api.fetch(publishRequest(invalid));
    assert.equal(response.status, 400);
    assert.equal(await repository.count(), 0);
  }
});
