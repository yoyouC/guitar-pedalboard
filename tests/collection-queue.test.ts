import assert from 'node:assert/strict';
import test from 'node:test';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';
import type { PresetCollection, PublishedPresetRevisionView } from '../shared/marketplace.ts';
import type { ApplicablePublishedPreset } from '../src/marketplace/applyPublishedPreset.ts';
import { createCollectionQueueSession } from '../src/marketplace/collectionQueue.ts';

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

function revisionView(id: string, revisionId: string): PublishedPresetRevisionView {
  return {
    id,
    title: demoPublishedPreset.title,
    description: demoPublishedPreset.description,
    visibility: 'public',
    creator: demoPublishedPreset.creator,
    tags: demoPublishedPreset.tags,
    revision: { ...structuredClone(demoPublishedPreset.currentRevision), id: revisionId },
    currentRevisionId: 'newer-current-revision',
    createdAt: demoPublishedPreset.createdAt,
    updatedAt: demoPublishedPreset.updatedAt,
  };
}

const collection: PresetCollection = {
  id: 'collection-live-set',
  title: 'Live Set',
  description: '',
  visibility: 'public',
  creator: { id: 'curator', handle: 'curator', displayName: 'Curator' },
  tags: demoPublishedPreset.tags,
  items: [
    { position: 0, presetId: 'tone-a', revisionId: 'revision-a-fixed', availability: 'available', title: 'A', creator: demoPublishedPreset.creator },
    { position: 1, presetId: 'tone-gone', revisionId: 'revision-gone', availability: 'unavailable', title: null, creator: demoPublishedPreset.creator },
    { position: 2, presetId: 'tone-b', revisionId: 'revision-b-fixed', availability: 'available', title: 'B', creator: demoPublishedPreset.creator },
  ],
  createdAt: demoPublishedPreset.createdAt,
  updatedAt: demoPublishedPreset.updatedAt,
};

test('collection queue applies fixed revisions, skips unavailable placeholders, and stays session-only', async () => {
  const requested: Array<[string, string]> = [];
  const applied: string[] = [];
  const storage = new MemoryStorage();
  const revisions = {
    async getPublishedPresetRevision(id: string, revisionId: string) {
      requested.push([id, revisionId]);
      return revisionView(id, revisionId);
    },
  };
  const tones = {
    async apply(preset: ApplicablePublishedPreset) {
      applied.push(preset.currentRevision.id);
      return { ok: true };
    },
  };
  const queue = createCollectionQueueSession(revisions, tones, storage);

  assert.deepEqual(await queue.start(collection, 0), { ok: true });
  assert.equal(queue.nextPosition(), 2);
  assert.equal(queue.previousPosition(), null);
  assert.deepEqual(await queue.switchTo(2), { ok: true });
  assert.deepEqual(requested, [
    ['tone-a', 'revision-a-fixed'],
    ['tone-b', 'revision-b-fixed'],
  ]);
  assert.deepEqual(applied, ['revision-a-fixed', 'revision-b-fixed']);
  assert.equal(queue.getState().queue?.currentPosition, 2);
  assert.equal(queue.previousPosition(), 0);
  assert.equal(queue.getState().queue?.items[1].availability, 'unavailable');

  const restored = createCollectionQueueSession(revisions, tones, storage);
  assert.equal(restored.getState().queue?.collectionId, collection.id);
  assert.equal(restored.getState().queue?.currentPosition, 2);
  restored.clear();
  assert.equal(storage.values.size, 0);
});

test('collection queue never activates an unavailable position', async () => {
  const queue = createCollectionQueueSession({
    async getPublishedPresetRevision() { throw new Error('must not load'); },
  }, {
    async apply() { throw new Error('must not apply'); },
  });
  const result = await queue.start(collection, 1);
  assert.equal(result.ok, false);
  assert.equal(queue.getState().queue, null);
});
