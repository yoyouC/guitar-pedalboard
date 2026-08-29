import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarketplaceApi } from '../server/marketplace/api.ts';
import { createMemoryPublishedPresetRepository } from '../server/marketplace/memoryRepository.ts';
import { createMemoryMemberRepository } from '../server/members/memoryRepository.ts';
import type {
  CanonicalPublishedPreset,
  MarketplaceTag,
  PublishedPreset,
} from '../shared/marketplace.ts';
import type { AuthenticatedIdentity } from '../server/auth/session.ts';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';

const publishedPreset: CanonicalPublishedPreset = {
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
    payloadKind: 'canonical-rig',
    id: 'revision-demo-crunch-1',
    schemaVersion: 5,
    createdAt: '2026-08-29T00:00:00.000Z',
    resourceDependencies: [{ kind: 'builtin' }],
    derivedAttributes: demoPublishedPreset.derivedAttributes,
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
  communityStatus: 'active' | 'banned' = 'active',
) {
  const members = communityStatus === 'banned' ? createMemoryMemberRepository([{
    id: 'member-ada', authUserId: adaIdentity.authUserId,
    handle: 'ada', displayName: 'Ada', bio: '', avatarUrl: null,
    handleChangedAt: null,
    createdAt: new Date('2026-08-29T00:00:00.000Z'),
    updatedAt: new Date('2026-08-29T00:00:00.000Z'),
    communityStatus,
  }]) : createMemoryMemberRepository();
  return {
    repository,
    api: createMarketplaceApi({
      publishedPresets: repository,
      publication: {
        repository,
        sessions: { async verify() { return identity; } },
        members,
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

function managementApi(memberId = 'member-ada', sourcePreset: CanonicalPublishedPreset = publishedPreset) {
  const ownedPreset: CanonicalPublishedPreset = {
    ...sourcePreset,
    id: 'preset-ada-crunch',
    creator: { id: 'member-ada', handle: 'ada', displayName: 'Ada' },
  };
  const repository = createMemoryPublishedPresetRepository([ownedPreset], controlledTags);
  const members = createMemoryMemberRepository([{
    id: memberId,
    authUserId: adaIdentity.authUserId,
    handle: memberId === 'member-ada' ? 'ada' : 'mallory',
    displayName: memberId === 'member-ada' ? 'Ada' : 'Mallory',
    bio: '',
    avatarUrl: null,
    handleChangedAt: null,
    createdAt: new Date('2026-08-29T00:00:00.000Z'),
    updatedAt: new Date('2026-08-29T00:00:00.000Z'),
  }]);
  let nowIndex = 0;
  let revisionIndex = 1;
  const api = createMarketplaceApi({
    publishedPresets: repository,
    publication: {
      repository,
      sessions: { async verify() { return adaIdentity; } },
      members,
      now: () => new Date(`2026-08-29T10:00:0${nowIndex++}.000Z`),
      createPresetId: () => 'unused-preset-id',
      createRevisionId: () => `revision-ada-crunch-${++revisionIndex}`,
      createMemberId: () => 'unused-member-id',
      createHandleSuffix: () => 'unused001',
    },
  });
  return { api, repository, ownedPreset };
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
      async findVisibleById() {
        throw new Error('database offline');
      },
      async findVisibleRevisionById() {
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

test('banned member cannot publish a new community work', async () => {
  const banned = publicationApi(undefined, adaIdentity, 'banned');
  const response = await banned.api.fetch(publishRequest());
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'member_banned');
  assert.equal(await banned.repository.count(), 0);
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

test('publishing another creator revision creates a Remix with permanent source attribution', async () => {
  const repository = createMemoryPublishedPresetRepository([publishedPreset], controlledTags);
  const { api } = publicationApi(repository);

  const response = await api.fetch(publishRequest({
    source: {
      presetId: publishedPreset.id,
      revisionId: publishedPreset.currentRevision.id,
    },
  }));
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.deepEqual(body.preset.source, {
    presetId: publishedPreset.id,
    revisionId: publishedPreset.currentRevision.id,
    creator: publishedPreset.creator,
    availability: 'available',
    title: publishedPreset.title,
  });

  await repository.updateVisibility({
    presetId: publishedPreset.id,
    creatorId: publishedPreset.creator.id,
    visibility: 'withdrawn',
    expectedUpdatedAt: new Date(publishedPreset.updatedAt),
    now: new Date('2026-08-29T11:00:00.000Z'),
  });
  const detail = await api.fetch(new Request(
    'https://pedalboard.test/api/marketplace/presets/preset-ada-crunch',
  ));
  const detailBody = await detail.json();
  assert.equal(detail.status, 200);
  assert.deepEqual(detailBody.preset.source, {
    presetId: publishedPreset.id,
    revisionId: publishedPreset.currentRevision.id,
    creator: publishedPreset.creator,
    availability: 'unavailable',
    title: null,
  });
});

test('publication rejects forged, mismatched, and self-owned Remix sources atomically', async () => {
  const secondSource: CanonicalPublishedPreset = {
    ...publishedPreset,
    id: 'preset-second-source',
    currentRevision: {
      ...publishedPreset.currentRevision,
      id: 'revision-second-source-1',
    },
  };
  const ownSource: CanonicalPublishedPreset = {
    ...publishedPreset,
    id: 'preset-owned-source',
    creator: { id: 'member-ada', handle: 'ada', displayName: 'Ada' },
  };
  const cases = [
    { presetId: 'missing-preset', revisionId: 'missing-revision' },
    { presetId: publishedPreset.id, revisionId: secondSource.currentRevision.id },
    { presetId: ownSource.id, revisionId: ownSource.currentRevision.id },
  ];

  for (const source of cases) {
    const repository = createMemoryPublishedPresetRepository(
      [publishedPreset, secondSource, ownSource],
      controlledTags,
    );
    const { api } = publicationApi(repository);
    const response = await api.fetch(publishRequest({ source }));
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'invalid_publication');
    assert.equal(typeof body.error.fields.source, 'string');
    assert.equal(await repository.count(), 3);
  }
});

test('Rig edits append immutable revisions while fixed revision URLs keep the original sound', async () => {
  const { api, ownedPreset } = managementApi();
  const nextRig = {
    ...ownedPreset.currentRevision.rig,
    amp: {
      ...ownedPreset.currentRevision.rig.amp,
      values: { ...ownedPreset.currentRevision.rig.amp.values, gain: 61 },
    },
  };
  const append = await api.fetch(new Request(
    'https://pedalboard.test/api/marketplace/presets/preset-ada-crunch/revisions',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 5,
        rig: nextRig,
        expectedUpdatedAt: ownedPreset.updatedAt,
      }),
    },
  ));
  const appended = await append.json();
  assert.equal(append.status, 201);
  assert.equal(appended.preset.currentRevision.id, 'revision-ada-crunch-2');
  assert.equal(appended.preset.currentRevision.rig.amp.values.gain, 61);

  const fixed = await api.fetch(new Request(
    'https://pedalboard.test/api/marketplace/presets/preset-ada-crunch/revisions/revision-demo-crunch-1',
  ));
  const fixedBody = await fixed.json();
  assert.equal(fixed.status, 200);
  assert.equal(fixedBody.preset.currentRevisionId, 'revision-ada-crunch-2');
  assert.equal(fixedBody.preset.revision.id, 'revision-demo-crunch-1');
  assert.equal(fixedBody.preset.revision.rig.amp.values.gain, 60);
});

test('a removed catalog item does not break its fixed revision link or copy-and-restore', async () => {
  const retiredAttributes = {
    ...publishedPreset.derivedAttributes,
    pedalIds: ['retired-pedal'],
  };
  const retiredPreset: CanonicalPublishedPreset = {
    ...publishedPreset,
    derivedAttributes: retiredAttributes,
    currentRevision: {
      ...publishedPreset.currentRevision,
      derivedAttributes: retiredAttributes,
      rig: {
        ...publishedPreset.currentRevision.rig,
        chain: [{
          effectId: 'retired-pedal',
          enabled: true,
          values: { drive: 42 },
          post: false,
        }],
      },
    },
  };
  const { api, ownedPreset } = managementApi('member-ada', retiredPreset);
  const append = await api.fetch(new Request(
    'https://pedalboard.test/api/marketplace/presets/preset-ada-crunch/revisions',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 5,
        rig: publishedPreset.currentRevision.rig,
        expectedUpdatedAt: ownedPreset.updatedAt,
      }),
    },
  ));
  const appended = await append.json();
  assert.equal(append.status, 201);

  const fixed = await api.fetch(new Request(
    'https://pedalboard.test/api/marketplace/presets/preset-ada-crunch/revisions/revision-demo-crunch-1',
  ));
  const fixedBody = await fixed.json();
  assert.equal(fixed.status, 200);
  assert.equal(fixedBody.preset.revision.rig.chain[0].effectId, 'retired-pedal');

  const restore = await api.fetch(new Request(
    'https://pedalboard.test/api/marketplace/presets/preset-ada-crunch/revisions/revision-demo-crunch-1/restore',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedUpdatedAt: appended.preset.updatedAt }),
    },
  ));
  const restored = await restore.json();
  assert.equal(restore.status, 201);
  assert.equal(restored.preset.currentRevision.id, 'revision-ada-crunch-3');
  assert.equal(restored.preset.currentRevision.rig.chain[0].effectId, 'retired-pedal');
  assert.deepEqual(restored.preset.derivedAttributes, retiredAttributes);
});

test('metadata edits keep the sound revision and enforce the shared metadata contract', async () => {
  const { api, ownedPreset } = managementApi();
  const update = await api.fetch(new Request(
    'https://pedalboard.test/api/marketplace/presets/preset-ada-crunch/metadata',
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Ada Crunch v2',
        description: 'New words, same sound.',
        tagIds: ['genre-rock'],
        expectedUpdatedAt: ownedPreset.updatedAt,
      }),
    },
  ));
  const body = await update.json();
  assert.equal(update.status, 200);
  assert.equal(body.preset.title, 'Ada Crunch v2');
  assert.equal(body.preset.currentRevision.id, ownedPreset.currentRevision.id);

  const invalid = await api.fetch(new Request(
    'https://pedalboard.test/api/marketplace/presets/preset-ada-crunch/metadata',
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'x'.repeat(81),
        description: '',
        tagIds: ['genre-rock'],
        expectedUpdatedAt: body.preset.updatedAt,
      }),
    },
  ));
  assert.equal(invalid.status, 400);
});

test('restoring an old revision copies its Rig into a new current revision', async () => {
  const { api, ownedPreset } = managementApi();
  const append = await api.fetch(new Request(
    'https://pedalboard.test/api/marketplace/presets/preset-ada-crunch/revisions',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 5,
        rig: {
          ...ownedPreset.currentRevision.rig,
          globals: { ...ownedPreset.currentRevision.rig.globals, masterVolume: 0.8 },
        },
        expectedUpdatedAt: ownedPreset.updatedAt,
      }),
    },
  ));
  const appended = await append.json();
  const restore = await api.fetch(new Request(
    'https://pedalboard.test/api/marketplace/presets/preset-ada-crunch/revisions/revision-demo-crunch-1/restore',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedUpdatedAt: appended.preset.updatedAt }),
    },
  ));
  const restored = await restore.json();
  assert.equal(restore.status, 201);
  assert.equal(restored.preset.currentRevision.id, 'revision-ada-crunch-3');
  assert.equal(restored.preset.currentRevision.rig.globals.masterVolume, 0.5);

  const history = await api.fetch(new Request(
    'https://pedalboard.test/api/marketplace/presets/preset-ada-crunch/revisions',
  ));
  const historyBody = await history.json();
  assert.deepEqual(historyBody.revisions.map((revision: { id: string }) => revision.id), [
    'revision-ada-crunch-3',
    'revision-ada-crunch-2',
    'revision-demo-crunch-1',
  ]);
});

test('visibility transitions preserve direct links, hide withdrawn bodies, and can restore', async () => {
  const { api, ownedPreset } = managementApi();
  const setVisibility = async (visibility: string, expectedUpdatedAt: string) => {
    const response = await api.fetch(new Request(
      'https://pedalboard.test/api/marketplace/presets/preset-ada-crunch/visibility',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visibility, expectedUpdatedAt }),
      },
    ));
    return { response, body: await response.json() };
  };

  const unlisted = await setVisibility('unlisted', ownedPreset.updatedAt);
  assert.equal(unlisted.response.status, 200);
  const direct = await api.fetch(new Request(
    'https://pedalboard.test/api/marketplace/presets/preset-ada-crunch',
  ));
  assert.equal(direct.status, 200);
  assert.equal((await direct.json()).preset.visibility, 'unlisted');

  const withdrawn = await setVisibility('withdrawn', unlisted.body.preset.updatedAt);
  assert.equal(withdrawn.response.status, 200);
  assert.equal((await api.fetch(new Request(
    'https://pedalboard.test/api/marketplace/presets/preset-ada-crunch',
  ))).status, 404);
  const authorReload = await api.fetch(new Request(
    'https://pedalboard.test/api/marketplace/presets/preset-ada-crunch/manage',
  ));
  assert.equal(authorReload.status, 200);
  assert.equal((await authorReload.json()).preset.visibility, 'withdrawn');
  assert.equal((await api.fetch(new Request(
    'https://pedalboard.test/api/marketplace/presets/preset-ada-crunch/revisions/revision-demo-crunch-1',
  ))).status, 404);

  const restored = await setVisibility('public', withdrawn.body.preset.updatedAt);
  assert.equal(restored.response.status, 200);
  assert.equal(restored.body.preset.id, ownedPreset.id);
});

test('management rejects non-owners and returns recoverable optimistic conflict state', async () => {
  const foreign = managementApi('member-mallory');
  const forbidden = await foreign.api.fetch(new Request(
    'https://pedalboard.test/api/marketplace/presets/preset-ada-crunch/visibility',
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'unlisted', expectedUpdatedAt: foreign.ownedPreset.updatedAt }),
    },
  ));
  assert.equal(forbidden.status, 404);

  const owner = managementApi();
  const conflict = await owner.api.fetch(new Request(
    'https://pedalboard.test/api/marketplace/presets/preset-ada-crunch/visibility',
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'unlisted', expectedUpdatedAt: '2020-01-01T00:00:00.000Z' }),
    },
  ));
  const body = await conflict.json();
  assert.equal(conflict.status, 409);
  assert.equal(body.error.code, 'preset_update_conflict');
  assert.deepEqual(body.error.current, {
    updatedAt: owner.ownedPreset.updatedAt,
    currentRevisionId: owner.ownedPreset.currentRevision.id,
    visibility: 'public',
  });
});

test('optimistic concurrency advances even when two writes share the same wall-clock millisecond', async () => {
  const repository = createMemoryPublishedPresetRepository([publishedPreset], controlledTags);
  const updated = await repository.updateMetadata({
    presetId: publishedPreset.id,
    creatorId: publishedPreset.creator.id,
    title: 'Same Millisecond',
    description: publishedPreset.description,
    tagIds: publishedPreset.tags.map((tag) => tag.id),
    expectedUpdatedAt: new Date(publishedPreset.updatedAt),
    now: new Date(publishedPreset.updatedAt),
  });
  assert.notEqual(updated.updatedAt, publishedPreset.updatedAt);

  await assert.rejects(() => repository.updateVisibility({
    presetId: publishedPreset.id,
    creatorId: publishedPreset.creator.id,
    visibility: 'unlisted',
    expectedUpdatedAt: new Date(publishedPreset.updatedAt),
    now: new Date(publishedPreset.updatedAt),
  }));
});

test('historical revision payloads have no mutation or deletion route', async () => {
  const { api } = managementApi();
  const url = 'https://pedalboard.test/api/marketplace/presets/preset-ada-crunch/revisions/revision-demo-crunch-1';
  for (const method of ['PATCH', 'DELETE']) {
    const response = await api.fetch(new Request(url, { method }));
    assert.equal(response.status, 404);
  }
  const fixed = await api.fetch(new Request(url));
  assert.equal(fixed.status, 200);
  assert.equal((await fixed.json()).preset.revision.rig.amp.values.gain, 60);
});

test('memory restore rejects a corrupted historical dependency snapshot atomically', async () => {
  const corrupted: CanonicalPublishedPreset = {
    ...publishedPreset,
    currentRevision: {
      ...publishedPreset.currentRevision,
      resourceDependencies: [
        { kind: 'builtin' },
        { kind: 'tone3000', toneId: '999' },
      ],
    },
  };
  const repository = createMemoryPublishedPresetRepository([corrupted], controlledTags);
  await repository.appendRevision({
    presetId: corrupted.id,
    creatorId: corrupted.creator.id,
    revisionId: 'revision-clean-current',
    schemaVersion: publishedPreset.currentRevision.schemaVersion,
    rig: publishedPreset.currentRevision.rig,
    resourceDependencies: publishedPreset.currentRevision.resourceDependencies,
    derivedAttributes: publishedPreset.derivedAttributes,
    expectedUpdatedAt: new Date(corrupted.updatedAt),
    now: new Date('2026-08-29T01:00:00.000Z'),
  });

  await assert.rejects(() => repository.restoreRevision({
    presetId: corrupted.id,
    creatorId: corrupted.creator.id,
    sourceRevisionId: corrupted.currentRevision.id,
    revisionId: 'revision-must-not-exist',
    expectedUpdatedAt: new Date('2026-08-29T01:00:00.000Z'),
    now: new Date('2026-08-29T02:00:00.000Z'),
  }));

  assert.equal((await repository.findVisibleById(corrupted.id))?.currentRevision.id, 'revision-clean-current');
  assert.equal((await repository.listRevisions(corrupted.id, corrupted.creator.id)).length, 2);
});
