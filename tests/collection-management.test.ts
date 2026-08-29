import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuthenticatedIdentity, SessionVerifier } from '../server/auth/session.ts';
import { createPresetCollectionApi } from '../server/collections/api.ts';
import { createMemoryPresetCollectionRepository } from '../server/collections/memoryRepository.ts';
import { createMemoryPublishedPresetRepository } from '../server/marketplace/memoryRepository.ts';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';
import { createMemoryMemberRepository } from '../server/members/memoryRepository.ts';
import type { CanonicalPublishedPreset, MarketplaceTag } from '../shared/marketplace.ts';

const now = new Date('2026-08-29T10:00:00.000Z');
const tags: MarketplaceTag[] = [
  { id: 'genre-rock', dimension: 'genre', nameZh: '摇滚', nameEn: 'Rock' },
  { id: 'use-live', dimension: 'use', nameZh: '现场', nameEn: 'Live' },
];
const adaIdentity: AuthenticatedIdentity = {
  authUserId: 'auth-ada',
  email: 'ada@example.test',
  displayName: 'Ada',
  avatarUrl: null,
};

function session(identity: AuthenticatedIdentity | null): SessionVerifier {
  return { async verify() { return identity; } };
}

function ownPreset(visibility: CanonicalPublishedPreset['visibility'] = 'unlisted'):
CanonicalPublishedPreset {
  return {
    ...structuredClone(demoPublishedPreset),
    id: 'preset-ada-private',
    title: 'Ada Private',
    visibility,
    creator: { id: 'member-ada', handle: 'ada', displayName: 'Ada' },
    currentRevision: {
      ...structuredClone(demoPublishedPreset.currentRevision),
      id: 'revision-ada-private-1',
    },
  };
}

function createFixture(identity: AuthenticatedIdentity | null = adaIdentity) {
  const presets = createMemoryPublishedPresetRepository(
    [demoPublishedPreset, ownPreset()],
    tags,
  );
  const collections = createMemoryPresetCollectionRepository([], presets, tags);
  const api = createPresetCollectionApi({
    collections,
    management: {
      repository: collections,
      sessions: session(identity),
      members: createMemoryMemberRepository(),
      now: () => now,
      createCollectionId: () => 'collection-ada-live',
      createMemberId: () => 'member-ada',
      createHandleSuffix: () => 'ada',
    },
  });
  return { api, collections, presets };
}

function jsonRequest(path: string, method: 'POST' | 'PATCH', body: unknown): Request {
  return new Request(`https://pedalboard.test${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createCollection(api: ReturnType<typeof createPresetCollectionApi>) {
  return api.fetch(jsonRequest('/api/marketplace/collections', 'POST', {
    title: 'Live Set',
    description: 'Two fixed tones.',
    tagIds: ['genre-rock', 'use-live'],
    visibility: 'unlisted',
  }));
}

test('authenticated member creates one owned collection with controlled tags', async () => {
  const { api } = createFixture();
  const response = await createCollection(api);
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.collection.id, 'collection-ada-live');
  assert.equal(body.collection.creator.id, 'member-ada');
  assert.deepEqual(body.collection.tags.map((tag: MarketplaceTag) => tag.id), [
    'genre-rock',
    'use-live',
  ]);
  assert.deepEqual(body.collection.items, []);

  const anonymous = createFixture(null);
  const rejected = await createCollection(anonymous.api);
  assert.equal(rejected.status, 401);
});

test('owner atomically adds, sorts, removes, and explicitly upgrades fixed revisions', async () => {
  const { api, presets } = createFixture();
  const created = (await (await createCollection(api)).json()).collection;
  const upgraded = await presets.appendRevision({
    presetId: demoPublishedPreset.id,
    creatorId: demoPublishedPreset.creator.id,
    revisionId: 'revision-demo-crunch-2',
    schemaVersion: demoPublishedPreset.currentRevision.schemaVersion,
    rig: demoPublishedPreset.currentRevision.rig,
    resourceDependencies: demoPublishedPreset.currentRevision.resourceDependencies,
    derivedAttributes: demoPublishedPreset.derivedAttributes,
    expectedUpdatedAt: new Date(demoPublishedPreset.updatedAt),
    now: new Date('2026-08-29T10:30:00.000Z'),
  });

  const firstUpdate = await api.fetch(jsonRequest(
    '/api/marketplace/collections/collection-ada-live',
    'PATCH',
    {
      title: created.title,
      description: created.description,
      tagIds: created.tags.map((tag: MarketplaceTag) => tag.id),
      visibility: 'unlisted',
      items: [
        { presetId: demoPublishedPreset.id, revisionId: demoPublishedPreset.currentRevision.id },
        { presetId: 'preset-ada-private', revisionId: 'revision-ada-private-1' },
      ],
      expectedUpdatedAt: created.updatedAt,
    },
  ));
  const first = (await firstUpdate.json()).collection;
  assert.equal(firstUpdate.status, 200);
  assert.deepEqual(first.items.map((item: { presetId: string }) => item.presetId), [
    demoPublishedPreset.id,
    'preset-ada-private',
  ]);
  assert.equal(first.items[0].creator.id, demoPublishedPreset.creator.id);

  const secondUpdate = await api.fetch(jsonRequest(
    '/api/marketplace/collections/collection-ada-live',
    'PATCH',
    {
      title: 'Live Set v2',
      description: first.description,
      tagIds: ['genre-rock'],
      visibility: 'unlisted',
      items: [
        { presetId: 'preset-ada-private', revisionId: 'revision-ada-private-1' },
        { presetId: demoPublishedPreset.id, revisionId: upgraded.currentRevision.id },
      ],
      expectedUpdatedAt: first.updatedAt,
    },
  ));
  const second = (await secondUpdate.json()).collection;
  assert.equal(secondUpdate.status, 200);
  assert.equal(second.title, 'Live Set v2');
  assert.deepEqual(second.items.map((item: { revisionId: string }) => item.revisionId), [
    'revision-ada-private-1',
    'revision-demo-crunch-2',
  ]);
  assert.deepEqual(second.items.map((item: { position: number }) => item.position), [0, 1]);

  const remove = await api.fetch(jsonRequest(
    '/api/marketplace/collections/collection-ada-live',
    'PATCH',
    {
      title: second.title,
      description: second.description,
      tagIds: ['genre-rock'],
      visibility: 'unlisted',
      items: [{ presetId: demoPublishedPreset.id, revisionId: upgraded.currentRevision.id }],
      expectedUpdatedAt: second.updatedAt,
    },
  ));
  const afterRemove = (await remove.json()).collection;
  assert.equal(remove.status, 200);
  assert.deepEqual(afterRemove.items.map((item: { presetId: string }) => item.presetId), [
    demoPublishedPreset.id,
  ]);
});

test('a Public collection accepts another creators Public fixed revision', async () => {
  const { api } = createFixture();
  const created = (await (await createCollection(api)).json()).collection;
  const response = await api.fetch(jsonRequest(
    '/api/marketplace/collections/collection-ada-live',
    'PATCH',
    {
      title: created.title,
      description: created.description,
      tagIds: ['genre-rock'],
      visibility: 'public',
      items: [{
        presetId: demoPublishedPreset.id,
        revisionId: demoPublishedPreset.currentRevision.id,
      }],
      expectedUpdatedAt: created.updatedAt,
    },
  ));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.collection.visibility, 'public');
  assert.equal(body.collection.items[0].creator.id, demoPublishedPreset.creator.id);
});

test('server rejects Unlisted leaks, forged ownership, and stale overwrites', async () => {
  const { api, collections } = createFixture();
  const created = (await (await createCollection(api)).json()).collection;

  const leak = await api.fetch(jsonRequest(
    '/api/marketplace/collections/collection-ada-live',
    'PATCH',
    {
      title: created.title,
      description: created.description,
      tagIds: ['genre-rock'],
      visibility: 'public',
      items: [{ presetId: 'preset-ada-private', revisionId: 'revision-ada-private-1' }],
      expectedUpdatedAt: created.updatedAt,
    },
  ));
  assert.equal(leak.status, 400);
  assert.equal((await leak.json()).error.code, 'invalid_collection_reference');

  const forgedApi = createPresetCollectionApi({
    collections,
    management: {
      repository: collections,
      sessions: session({ ...adaIdentity, authUserId: 'auth-eve', email: 'eve@example.test' }),
      members: createMemoryMemberRepository(),
      now: () => now,
      createCollectionId: () => 'unused',
      createMemberId: () => 'member-eve',
      createHandleSuffix: () => 'eve',
    },
  });
  const forged = await forgedApi.fetch(jsonRequest(
    '/api/marketplace/collections/collection-ada-live',
    'PATCH',
    {
      title: 'Hijacked', description: '', tagIds: ['genre-rock'], visibility: 'unlisted',
      items: [], expectedUpdatedAt: created.updatedAt,
    },
  ));
  assert.equal(forged.status, 404);

  const valid = await api.fetch(jsonRequest(
    '/api/marketplace/collections/collection-ada-live',
    'PATCH',
    {
      title: 'Changed', description: '', tagIds: ['genre-rock'], visibility: 'unlisted',
      items: [], expectedUpdatedAt: created.updatedAt,
    },
  ));
  assert.equal(valid.status, 200);
  const stale = await api.fetch(jsonRequest(
    '/api/marketplace/collections/collection-ada-live',
    'PATCH',
    {
      title: 'Stale', description: '', tagIds: ['genre-rock'], visibility: 'unlisted',
      items: [], expectedUpdatedAt: created.updatedAt,
    },
  ));
  assert.equal(stale.status, 409);
  const staleBody = await stale.json();
  assert.equal(staleBody.error.code, 'collection_update_conflict');
  assert.equal(typeof staleBody.error.current.updatedAt, 'string');
});

test('other creators Unlisted preset is rejected even by an Unlisted collection', async () => {
  const otherPrivate = {
    ...structuredClone(demoPublishedPreset),
    id: 'preset-demo-private',
    visibility: 'unlisted' as const,
    currentRevision: {
      ...structuredClone(demoPublishedPreset.currentRevision),
      id: 'revision-demo-private-1',
    },
  };
  const presets = createMemoryPublishedPresetRepository([otherPrivate], tags);
  const collections = createMemoryPresetCollectionRepository([], presets, tags);
  const api = createPresetCollectionApi({
    collections,
    management: {
      repository: collections,
      sessions: session(adaIdentity),
      members: createMemoryMemberRepository(),
      now: () => now,
      createCollectionId: () => 'collection-private-test',
      createMemberId: () => 'member-ada',
      createHandleSuffix: () => 'ada',
    },
  });
  const created = (await (await createCollection(api)).json()).collection;
  const response = await api.fetch(jsonRequest(
    '/api/marketplace/collections/collection-private-test',
    'PATCH',
    {
      title: created.title, description: '', tagIds: ['genre-rock'], visibility: 'unlisted',
      items: [{ presetId: otherPrivate.id, revisionId: otherPrivate.currentRevision.id }],
      expectedUpdatedAt: created.updatedAt,
    },
  ));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'invalid_collection_reference');
});

test('Withdrawn collection cannot add Unlisted content but preserves an existing item as a placeholder', async () => {
  const { api } = createFixture();
  const created = (await (await createCollection(api)).json()).collection;
  const added = (await (await api.fetch(jsonRequest(
    '/api/marketplace/collections/collection-ada-live',
    'PATCH',
    {
      title: created.title, description: '', tagIds: ['genre-rock'], visibility: 'unlisted',
      items: [{ presetId: 'preset-ada-private', revisionId: 'revision-ada-private-1' }],
      expectedUpdatedAt: created.updatedAt,
    },
  ))).json()).collection;
  const withdrawn = await api.fetch(jsonRequest(
    '/api/marketplace/collections/collection-ada-live',
    'PATCH',
    {
      title: added.title, description: '', tagIds: ['genre-rock'], visibility: 'withdrawn',
      items: [{ presetId: 'preset-ada-private', revisionId: 'revision-ada-private-1' }],
      expectedUpdatedAt: added.updatedAt,
    },
  ));
  const withdrawnBody = await withdrawn.json();
  assert.equal(withdrawn.status, 200);
  assert.equal(withdrawnBody.collection.items[0].availability, 'unavailable');
  assert.equal(withdrawnBody.collection.items[0].title, null);

  const emptyFixture = createFixture();
  const empty = (await (await createCollection(emptyFixture.api)).json()).collection;
  const invalid = await emptyFixture.api.fetch(jsonRequest(
    '/api/marketplace/collections/collection-ada-live',
    'PATCH',
    {
      title: empty.title, description: '', tagIds: ['genre-rock'], visibility: 'withdrawn',
      items: [{ presetId: 'preset-ada-private', revisionId: 'revision-ada-private-1' }],
      expectedUpdatedAt: empty.updatedAt,
    },
  ));
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'invalid_collection_reference');
});
