import assert from 'node:assert/strict';
import test from 'node:test';
import { publishedPresetIdFromPath, publishedPresetRouteFromPath } from '../src/marketplace/route.ts';
import { creatorHandleFromPath } from '../src/marketplace/route.ts';
import { presetCollectionIdFromPath } from '../src/marketplace/route.ts';

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

test('preset revision paths preserve both stable identities', () => {
  assert.deepEqual(
    publishedPresetRouteFromPath('/marketplace/presets/preset-a/revisions/revision-1'),
    { presetId: 'preset-a', revisionId: 'revision-1' },
  );
  assert.deepEqual(
    publishedPresetRouteFromPath('/marketplace/presets/preset%20a/revisions/revision%201/'),
    { presetId: 'preset a', revisionId: 'revision 1' },
  );
});

test('creator profile paths resolve a stable handle', () => {
  assert.equal(creatorHandleFromPath('/creators/ada-tones'), 'ada-tones');
  assert.equal(creatorHandleFromPath('/creators/ada-tones/'), 'ada-tones');
  assert.equal(creatorHandleFromPath('/creators/ada%20tones'), 'ada tones');
  assert.equal(creatorHandleFromPath('/marketplace/creators/ada-tones'), null);
});

test('preset collection paths carry one stable collection identity', () => {
  assert.equal(
    presetCollectionIdFromPath('/marketplace/collections/collection-stage-tones'),
    'collection-stage-tones',
  );
  assert.equal(
    presetCollectionIdFromPath('/marketplace/collections/collection%20one/'),
    'collection one',
  );
  assert.equal(presetCollectionIdFromPath('/marketplace/collections'), null);
});
