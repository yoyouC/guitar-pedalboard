import assert from 'node:assert/strict';
import test from 'node:test';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';
import { clearPublishDraft, createPublishDraft, loadPublishDraft, publicationKind, savePublishDraft } from '../src/marketplace/publishDraft.ts';

function installSessionStorage() {
  const data = new Map<string, string>();
  const sessionStorage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { sessionStorage } });
}

test.beforeEach(installSessionStorage);

test('publication classification is locked by canonical provenance ownership', () => {
  assert.equal(publicationKind(null, 'member-me'), 'new-work');
  assert.equal(publicationKind({ presetId: 'mine', revisionId: 'mine-1', creatorId: 'member-me', presetUpdatedAt: 'now' }, 'member-me'), 'new-revision');
  assert.equal(publicationKind({ presetId: 'theirs', revisionId: 'theirs-4', creatorId: 'member-them', presetUpdatedAt: 'then' }, 'member-me'), 'remix');
});

test('same-browser publish draft preserves canonical Rig and preview without auto submission', () => {
  const source = { presetId: 'source', revisionId: 'source-2', creatorId: 'member-them', presetUpdatedAt: 'then' };
  const created = createPublishDraft(demoPublishedPreset.currentRevision.rig, source);
  savePublishDraft({ ...created, title: 'My Remix', tagIds: ['tone-crunch'], visibility: 'unlisted' });
  assert.deepEqual(loadPublishDraft(), { ...created, title: 'My Remix', tagIds: ['tone-crunch'], visibility: 'unlisted' });
  clearPublishDraft();
  assert.equal(loadPublishDraft(), null);
});
