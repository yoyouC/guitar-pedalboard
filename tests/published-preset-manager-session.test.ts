import assert from 'node:assert/strict';
import test from 'node:test';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';
import {
  runPublishedPresetManagerMutation,
} from '../src/marketplace/publishedPresetManagerSession.ts';
import type { PublishedPreset } from '../shared/marketplace.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

test('a stale manager mutation cannot overwrite a newly mounted preset route', async () => {
  const mutationA = deferred<PublishedPreset>();
  const mutationB = deferred<PublishedPreset>();
  const updated: string[] = [];
  const loaded: string[] = [];
  const source = {
    async listAvailableTags() { return demoPublishedPreset.tags; },
    async listPublishedPresetRevisions(presetId: string) {
      loaded.push(presetId);
      return [];
    },
  };
  const callbacks = {
    onUpdated: (preset: PublishedPreset) => updated.push(preset.id),
    onLoaded: () => {},
    onError: (cause: unknown) => assert.fail(String(cause)),
  };

  const cancelA = runPublishedPresetManagerMutation('preset-a', source, () => mutationA.promise, callbacks);
  cancelA();
  runPublishedPresetManagerMutation('preset-b', source, () => mutationB.promise, callbacks);

  mutationB.resolve({ ...demoPublishedPreset, id: 'preset-b' });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  mutationA.resolve({ ...demoPublishedPreset, id: 'preset-a' });
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(updated, ['preset-b']);
  assert.deepEqual(loaded, ['preset-b']);
});

test('an unmounted manager ignores a late mutation failure', async () => {
  const mutation = deferred<PublishedPreset>();
  const errors: unknown[] = [];
  const cancel = runPublishedPresetManagerMutation(
    'preset-a',
    {
      async listAvailableTags() { return []; },
      async listPublishedPresetRevisions() { return []; },
    },
    () => mutation.promise,
    {
      onUpdated: () => assert.fail('unmounted manager must not update'),
      onLoaded: () => assert.fail('unmounted manager must not load'),
      onError: (cause) => errors.push(cause),
    },
  );
  cancel();
  mutation.reject(new Error('late failure'));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(errors, []);
});
