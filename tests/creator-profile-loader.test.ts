import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicCreatorProfile, PublicCreatorWorkSummary } from '../shared/members.ts';
import { loadCreatorProfile } from '../src/members/loadCreatorProfile.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function creator(handle: string): PublicCreatorProfile {
  return {
    handle,
    displayName: handle,
    bio: '',
    avatarUrl: null,
  };
}

test('a stale creator request cannot overwrite or navigate the new route', async () => {
  const creators = new Map<string, ReturnType<typeof deferred<PublicCreatorProfile>>>();
  const works = new Map<string, ReturnType<typeof deferred<PublicCreatorWorkSummary[]>>>();
  const loaded: string[] = [];
  const errors: unknown[] = [];
  const loader = {
    fetchCreator(handle: string) {
      const request = deferred<PublicCreatorProfile>();
      creators.set(handle, request);
      return request.promise;
    },
    fetchWorks(handle: string) {
      const request = deferred<PublicCreatorWorkSummary[]>();
      works.set(handle, request);
      return request.promise;
    },
    onLoaded(nextCreator: PublicCreatorProfile) {
      loaded.push(nextCreator.handle);
    },
    onError(cause: unknown) {
      errors.push(cause);
    },
  };

  const cancelAda = loadCreatorProfile('ada-old', loader);
  cancelAda();
  loadCreatorProfile('grace', loader);

  creators.get('grace')?.resolve(creator('grace'));
  works.get('grace')?.resolve([]);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(loaded, ['grace']);

  creators.get('ada-old')?.resolve(creator('ada-canonical'));
  works.get('ada-old')?.resolve([]);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(loaded, ['grace']);
  assert.deepEqual(errors, []);
});

test('an unmounted creator route ignores a late failure', async () => {
  const creatorRequest = deferred<PublicCreatorProfile>();
  const worksRequest = deferred<PublicCreatorWorkSummary[]>();
  const errors: unknown[] = [];
  const cancel = loadCreatorProfile('ada', {
    fetchCreator: () => creatorRequest.promise,
    fetchWorks: () => worksRequest.promise,
    onLoaded: () => assert.fail('unmounted route must not load'),
    onError: (cause) => errors.push(cause),
  });

  cancel();
  creatorRequest.reject(new Error('late failure'));
  worksRequest.resolve([]);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(errors, []);
});
