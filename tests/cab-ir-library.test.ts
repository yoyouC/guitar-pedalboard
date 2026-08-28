import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import {
  BrowserCabIrLibrary,
  CAB_IR_LIBRARY_MAX_BYTES,
  planCabIrEviction,
} from '../src/audio/cabIrLibrary.ts';
import type { StoredCabIr } from '../src/audio/cabIrCoordinator.ts';

function record(hash: string, bytes: number, lastUsedAt: number): StoredCabIr {
  return {
    hash,
    name: `${hash}.wav`,
    blob: new Blob(['x']),
    bytes,
    channels: 1,
    originalSampleRate: 48_000,
    processedSampleRate: 48_000,
    durationSeconds: 0.1,
    trimmedFrames: 0,
    createdAt: lastUsedAt,
    lastUsedAt,
  };
}

test('eviction is LRU and never removes referenced IRs', () => {
  const records = [record('old', 30, 1), record('pinned', 30, 2), record('new', 30, 3)];
  const result = planCabIrEviction(records, new Set(['pinned']), 40, {
    maxCount: 4,
    maxBytes: 100,
  });
  assert.deepEqual(result, ['old']);
});

test('eviction throws when pinned records make capacity impossible', () => {
  const records = [record('a', 60, 1), record('b', 40, 2)];
  assert.throws(
    () => planCabIrEviction(records, new Set(['a', 'b']), 1, { maxCount: 16, maxBytes: 100 }),
    /引用中的 IR/,
  );
});

test('IndexedDB adapter keeps original Blob, deduplicates hash, and sorts by recency', async () => {
  let now = 10;
  const library = new BrowserCabIrLibrary({ indexedDb: new IDBFactory(), now: () => now });
  const first = record('same-hash', 1, 1);
  first.blob = new Blob(['original']);
  await library.put(first);
  await library.put({ ...record('newer', 1, 2), blob: new Blob(['newer']) });
  now = 30;
  await library.put({ ...record('same-hash', 1, 999), blob: new Blob(['replacement']) });

  const records = await library.list();
  assert.deepEqual(records.map((item) => item.hash), ['same-hash', 'newer']);
  assert.equal(await records[0].blob.text(), 'original');
  assert.equal(records[0].lastUsedAt, 30);
});

test('IndexedDB adapter lazily adds calibration to a legacy record without replacing its Blob', async () => {
  const library = new BrowserCabIrLibrary({ indexedDb: new IDBFactory() });
  const legacy = record('legacy', 8, 7);
  legacy.blob = new Blob(['original']);
  await library.put(legacy);

  await library.setCalibration('legacy', -13.25);

  const migrated = await library.get('legacy');
  assert.equal(migrated?.calibrationDb, -13.25);
  assert.equal(await migrated?.blob.text(), 'original');
  assert.equal(migrated?.lastUsedAt, 7);
});

test('IndexedDB adapter enforces count/LRU while preserving pinned references', async () => {
  const pinned = new Set(['0']);
  const library = new BrowserCabIrLibrary({
    indexedDb: new IDBFactory(),
    pinnedHashes: () => pinned,
  });
  for (let index = 0; index < 16; index++) await library.put(record(String(index), 1, index));
  await library.put(record('latest', 1, 20));

  assert.ok(await library.get('0'));
  assert.equal(await library.get('1'), null);
  assert.equal((await library.list()).length, 16);
  assert.equal(await library.delete('0'), false);
  assert.ok(await library.get('0'));
});

test('IndexedDB adapter rollback atomically restores inserted and evicted records', async () => {
  const library = new BrowserCabIrLibrary({ indexedDb: new IDBFactory() });
  for (let index = 0; index < 16; index++) await library.put(record(String(index), 1, index));
  const receipt = await library.put(record('candidate', 1, 20));
  assert.equal(await library.get('0'), null);
  assert.ok(await library.get('candidate'));

  await receipt.rollback();
  assert.ok(await library.get('0'));
  assert.equal(await library.get('candidate'), null);
  assert.equal((await library.list()).length, 16);
});

test('IndexedDB adapter rejects a single record beyond the 64MB bound', async () => {
  const library = new BrowserCabIrLibrary({ indexedDb: new IDBFactory() });
  await assert.rejects(
    library.put(record('too-large', CAB_IR_LIBRARY_MAX_BYTES + 1, 1)),
    /容量上限/,
  );
});
