import assert from 'node:assert/strict';
import test from 'node:test';
import { marketplaceSearchPath, marketplaceSearchRouteState } from '../src/marketplace/searchRoute.ts';

test('Tone Market query state round-trips through a shareable canonical URL', () => {
  const path = marketplaceSearchPath({
    text: 'clean lead',
    tagIds: ['genre-rock', 'use-lead'],
    pedalIds: ['overdrive'],
    ampIds: ['clean'],
    cabIds: ['open1x12'],
    resourceKinds: ['builtin'],
    resourceDependencyKeys: ['tone3000:123:456'],
    publishedAfter: '2026-08-01T00:00:00.000Z',
    cursor: 'next-page',
  });
  assert.equal(path, '/marketplace?q=clean+lead&tag=genre-rock&tag=use-lead&pedal=overdrive&amp=clean&cab=open1x12&resourceKind=builtin&resource=tone3000%3A123%3A456&publishedAfter=2026-08-01T00%3A00%3A00.000Z&cursor=next-page');
  assert.deepEqual(marketplaceSearchRouteState(path.slice(path.indexOf('?'))), {
    request: {
      text: 'clean lead',
      tagIds: ['genre-rock', 'use-lead'],
      pedalIds: ['overdrive'],
      ampIds: ['clean'],
      cabIds: ['open1x12'],
      resourceKinds: ['builtin'],
      resourceDependencyKeys: ['tone3000:123:456'],
      publishedAfter: '2026-08-01T00:00:00.000Z',
      publishedBefore: undefined,
      cursor: 'next-page',
      limit: 12,
    },
    error: null,
  });
});

test('invalid dates and exact dependencies are visible route errors', () => {
  assert.match(marketplaceSearchRouteState('?publishedAfter=nope').error ?? '', /发布时间/);
  assert.match(marketplaceSearchRouteState('?resource=tone3000:nope').error ?? '', /资源依赖/);
});
