import assert from 'node:assert/strict';
import test from 'node:test';
import { publishedPresetIdFromPath } from '../src/marketplace/route.ts';

test('published preset detail paths carry stable identity without relying on a slug', () => {
  assert.equal(
    publishedPresetIdFromPath('/marketplace/presets/preset-demo-crunch'),
    'preset-demo-crunch',
  );
  assert.equal(
    publishedPresetIdFromPath('/marketplace/presets/preset%20with%20spaces/'),
    'preset with spaces',
  );
  assert.equal(publishedPresetIdFromPath('/marketplace/presets'), null);
  assert.equal(publishedPresetIdFromPath('/'), null);
});
