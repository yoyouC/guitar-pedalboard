import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearPendingMarketplaceLike,
  readPendingMarketplaceLike,
  rememberPendingMarketplaceLike,
} from '../src/marketplace/likeIntent.ts';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
    removeItem(key: string) { values.delete(key); },
  };
}

test('anonymous Like intent survives login navigation and is consumed explicitly', () => {
  const storage = memoryStorage();
  rememberPendingMarketplaceLike(storage, { kind: 'preset', targetId: 'tone-1' });
  assert.deepEqual(readPendingMarketplaceLike(storage), { kind: 'preset', targetId: 'tone-1' });
  clearPendingMarketplaceLike(storage);
  assert.equal(readPendingMarketplaceLike(storage), null);
});

test('malformed pending Like intent is ignored', () => {
  const storage = memoryStorage();
  storage.setItem('guitar-pedalboard.marketplace.pending-like.v1', '{bad json');
  assert.equal(readPendingMarketplaceLike(storage), null);
  storage.setItem('guitar-pedalboard.marketplace.pending-like.v1', JSON.stringify({ kind: 'preset' }));
  assert.equal(readPendingMarketplaceLike(storage), null);
});
