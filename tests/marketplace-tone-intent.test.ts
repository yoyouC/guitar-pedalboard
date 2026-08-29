import assert from 'node:assert/strict';
import test from 'node:test';
import {
  peekMarketplaceToneApplyIntent,
  popMarketplaceToneApplyIntent,
  stashMarketplaceToneApplyIntent,
} from '../src/marketplace/marketplaceToneIntent.ts';

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

test('Connect & Continue preserves one fixed Tone intent across a full redirect', () => {
  const storage = new MemoryStorage();
  const intent = {
    presetId: 'preset-a', revisionId: 'revision-a',
    returnPath: '/marketplace/tones/preset-a/revisions/revision-a',
  };
  stashMarketplaceToneApplyIntent(intent, storage);
  assert.deepEqual(peekMarketplaceToneApplyIntent(storage), intent);
  assert.deepEqual(popMarketplaceToneApplyIntent(storage), intent);
  assert.equal(peekMarketplaceToneApplyIntent(storage), null);
});

test('marketplace Tone intent rejects a non-Tone return path', () => {
  const storage = new MemoryStorage();
  storage.setItem('guitar-pedalboard:marketplace-tone3000-apply:v1', JSON.stringify({
    presetId: 'preset-a', revisionId: 'revision-a', returnPath: 'https://evil.test/',
  }));
  assert.equal(peekMarketplaceToneApplyIntent(storage), null);
  assert.equal(storage.values.size, 0);
});
