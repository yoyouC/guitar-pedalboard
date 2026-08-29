import assert from 'node:assert/strict';
import test from 'node:test';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';
import { seedPublishedPreset } from '../server/marketplace/seed.ts';

test('clean-database seed creates the preset before its FK-backed tags and projection', async () => {
  let presetExists = false;
  let revisionExists = false;
  const writes: string[] = [];
  await seedPublishedPreset({
    async query(text) {
      if (text.includes('marketplace_published_preset_tags') && !presetExists) {
        throw new Error('tag preset FK missing');
      }
      if (text.includes('marketplace_published_preset_search_projection') && !presetExists) {
        throw new Error('projection preset FK missing');
      }
      if (text.includes('marketplace_published_preset_revisions') && !presetExists) {
        throw new Error('revision preset FK missing');
      }
      if (text.includes('INSERT INTO marketplace_published_presets')) presetExists = true;
      if (text.includes('INSERT INTO marketplace_published_preset_revisions')) revisionExists = true;
      writes.push(text.match(/INSERT INTO ([a-z_]+)/)?.[1] ?? 'unknown');
      return {};
    },
  }, demoPublishedPreset);

  assert.equal(presetExists, true);
  assert.equal(revisionExists, true);
  assert.deepEqual(writes.slice(-4), [
    'marketplace_published_presets',
    'marketplace_published_preset_revisions',
    'marketplace_published_preset_tags',
    'marketplace_published_preset_search_projection',
  ]);
});
