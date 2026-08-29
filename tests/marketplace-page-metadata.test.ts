import assert from 'node:assert/strict';
import test from 'node:test';
import { marketplacePageMetadata } from '../src/marketplace/pageMetadata.ts';

test('Public marketplace pages expose descriptive canonical identity URLs', () => {
  assert.deepEqual(marketplacePageMetadata({
    kind: 'preset', id: 'preset-ada', title: 'Ada Crunch',
    description: 'A dynamic British crunch tone.', visibility: 'public',
    origin: 'https://pedalboard.example',
  }), {
    title: 'Ada Crunch · Guitar Pedalboard',
    description: 'A dynamic British crunch tone.',
    canonicalUrl: 'https://pedalboard.example/marketplace/tones/preset-ada',
    robots: 'index,follow',
  });
  assert.equal(marketplacePageMetadata({
    kind: 'creator', id: 'member-ada', title: 'Ada Lovelace',
    description: '@ada-new · Guitar tones', visibility: 'public',
    origin: 'https://pedalboard.example',
  }).canonicalUrl, 'https://pedalboard.example/creators/id/member-ada');
  assert.equal(marketplacePageMetadata({
    kind: 'preset', id: 'preset-ada', revisionId: 'revision-2', title: 'Ada Crunch v2',
    description: 'Fixed revision.', visibility: 'public', origin: 'https://pedalboard.example',
  }).canonicalUrl, 'https://pedalboard.example/marketplace/tones/preset-ada/revisions/revision-2');
});

test('Unlisted pages keep their stable direct URL but explicitly refuse indexing', () => {
  assert.deepEqual(marketplacePageMetadata({
    kind: 'collection', id: 'collection-secret', title: 'Secret Set',
    description: '', visibility: 'unlisted', origin: 'https://pedalboard.example',
  }), {
    title: 'Secret Set · Guitar Pedalboard',
    description: 'Guitar Pedalboard 音色广场内容',
    canonicalUrl: 'https://pedalboard.example/marketplace/collections/collection-secret',
    robots: 'noindex,nofollow',
  });
});
