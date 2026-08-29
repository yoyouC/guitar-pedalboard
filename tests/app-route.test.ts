import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAppRoute } from '../src/app/route.ts';

test('the root and TONE3000 callback keep the Pedalboard surface', () => {
  assert.deepEqual(resolveAppRoute('/'), { kind: 'pedalboard', section: 'pedalboard' });
  assert.deepEqual(resolveAppRoute('/tone3000/callback'), {
    kind: 'pedalboard',
    section: 'pedalboard',
  });
});

test('marketplace routes select independent marketplace pages', () => {
  assert.deepEqual(resolveAppRoute('/marketplace'), {
    kind: 'marketplace-search',
    section: 'marketplace',
  });
  assert.deepEqual(resolveAppRoute('/marketplace/search'), {
    kind: 'marketplace-search',
    section: 'marketplace',
  });
  for (const path of ['/marketplace/popular', '/marketplace/trending', '/marketplace/latest']) {
    assert.deepEqual(resolveAppRoute(path), {
      kind: 'marketplace-ranking',
      section: 'marketplace',
    });
  }
  assert.deepEqual(resolveAppRoute('/marketplace/presets/preset-demo-crunch'), {
    kind: 'published-preset',
    section: 'marketplace',
  });
  assert.deepEqual(resolveAppRoute('/marketplace/presets/preset-demo/revisions/rev-1'), {
    kind: 'published-preset',
    section: 'marketplace',
  });
  assert.deepEqual(resolveAppRoute('/marketplace/tones/preset-demo/revisions/rev-1'), {
    kind: 'published-preset',
    section: 'marketplace',
  });
  assert.deepEqual(resolveAppRoute('/marketplace/collections/stage-tones'), {
    kind: 'preset-collection',
    section: 'marketplace',
  });
  assert.deepEqual(resolveAppRoute('/creators/player-one'), {
    kind: 'creator-profile',
    section: 'marketplace',
  });
  assert.deepEqual(resolveAppRoute('/creators/id/member-one'), {
    kind: 'creator-profile',
    section: 'marketplace',
  });
  assert.deepEqual(resolveAppRoute('/marketplace/infringement-notice'), {
    kind: 'infringement-notice',
    section: 'marketplace',
  });
});

test('future member destinations are content pages instead of the Pedalboard', () => {
  assert.deepEqual(resolveAppRoute('/login/'), { kind: 'login', section: 'account' });
  assert.deepEqual(resolveAppRoute('/library'), { kind: 'library', section: 'account' });
  assert.deepEqual(resolveAppRoute('/marketplace/me/likes'), { kind: 'library', section: 'account' });
  assert.deepEqual(resolveAppRoute('/settings'), { kind: 'settings', section: 'account' });
  assert.deepEqual(resolveAppRoute('/marketplace/me/moderation'), {
    kind: 'moderation-cases', section: 'account',
  });
  assert.deepEqual(resolveAppRoute('/publish'), { kind: 'publish', section: 'account' });
  assert.deepEqual(resolveAppRoute('/library/tones/tone-1'), { kind: 'tone-manage', section: 'account' });
  assert.deepEqual(resolveAppRoute('/library/collections/set-1'), { kind: 'collection-manage', section: 'account' });
});

test('unknown paths never fall through to the instrument surface', () => {
  assert.deepEqual(resolveAppRoute('/marketplace/missing'), {
    kind: 'not-found',
    section: 'unknown',
  });
});
