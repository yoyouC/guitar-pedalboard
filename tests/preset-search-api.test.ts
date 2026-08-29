import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryPublishedPresetRepository } from '../server/marketplace/memoryRepository.ts';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';
import { createPublishedPresetSearchApi } from '../server/search/api.ts';
import type {
  CanonicalPublishedPreset,
  MarketplaceMemberSummary,
  MarketplaceTag,
  RigDerivedAttributes,
} from '../shared/marketplace.ts';

const rockTag: MarketplaceTag = {
  id: 'genre-rock', dimension: 'genre', nameZh: '摇滚', nameEn: 'Rock',
};
const cleanTag: MarketplaceTag = {
  id: 'tone-clean', dimension: 'tone', nameZh: '清音', nameEn: 'Clean',
};
const sparkleTag: MarketplaceTag = {
  id: 'tone-sparkle', dimension: 'tone', nameZh: '晶亮', nameEn: 'Sparkle',
};
const tags = [rockTag, cleanTag, sparkleTag];

function fixturePreset(input: {
  id: string;
  title: string;
  description?: string;
  visibility?: CanonicalPublishedPreset['visibility'];
  creator?: MarketplaceMemberSummary;
  tags?: MarketplaceTag[];
  createdAt?: string;
  derivedAttributes?: RigDerivedAttributes;
}): CanonicalPublishedPreset {
  return {
    ...structuredClone(demoPublishedPreset),
    id: input.id,
    title: input.title,
    description: input.description ?? '',
    visibility: input.visibility ?? 'public',
    creator: input.creator ?? demoPublishedPreset.creator,
    tags: input.tags ?? [rockTag],
    currentRevision: {
      ...structuredClone(demoPublishedPreset.currentRevision),
      id: `revision-${input.id}`,
    },
    derivedAttributes: input.derivedAttributes ?? structuredClone(demoPublishedPreset.derivedAttributes),
    createdAt: input.createdAt ?? demoPublishedPreset.createdAt,
    updatedAt: input.createdAt ?? demoPublishedPreset.updatedAt,
  };
}

function searchFixture() {
  const repository = createMemoryPublishedPresetRepository([
    fixturePreset({
      id: 'preset-cafe-rock',
      title: 'Café Rock',
      description: 'Warm stage drive',
      creator: { id: 'member-zoe', handle: 'Zoë-Tones', displayName: 'Zoë' },
    }),
    fixturePreset({ id: 'preset-clean', title: 'Crystal Clean', tags: [cleanTag] }),
    fixturePreset({ id: 'preset-sparkle', title: 'Neutral Sound', tags: [sparkleTag] }),
    fixturePreset({ id: 'preset-unlisted', title: 'Secret Distortion', visibility: 'unlisted' }),
    fixturePreset({ id: 'preset-withdrawn', title: 'Withdrawn-only Distortion', visibility: 'withdrawn' }),
    fixturePreset({ id: 'preset-hidden', title: 'Hidden-only Distortion', visibility: 'hidden' }),
  ], [
    { ...rockTag, aliases: ['distortion', 'rock tone'] },
    { ...cleanTag, aliases: ['clean tone'] },
    { ...sparkleTag, aliases: ['glisten'] },
  ]);
  return createPublishedPresetSearchApi({ presets: repository });
}

async function search(q: string) {
  const response = await searchFixture().fetch(new Request(
    `https://pedalboard.test/api/marketplace/search/presets?q=${encodeURIComponent(q)}`,
  ));
  assert.equal(response.status, 200);
  return response.json();
}

test('public preset search normalizes every text field and supports prefixes and basic typos', async () => {
  for (const query of ['ＣＡＦＥ', 'warm', 'zoe-', '摇滚', 'distorsion', 'rock t']) {
    const body = await search(query);
    assert.deepEqual(body.items.map((item: { id: string }) => item.id), ['preset-cafe-rock']);
  }
  assert.deepEqual(
    (await search('sparkle')).items.map((item: { id: string }) => item.id),
    ['preset-sparkle'],
  );
});

test('non-Public preset text never leaks into search results', async () => {
  for (const query of ['secret', 'withdrawn-only', 'hidden-only']) {
    const body = await search(query);
    assert.deepEqual(body.items, []);
    assert.equal(JSON.stringify(body).includes('preset-unlisted'), false);
    assert.equal(JSON.stringify(body).includes('preset-withdrawn'), false);
    assert.equal(JSON.stringify(body).includes('preset-hidden'), false);
  }
});

test('search applies exact Rig-derived and publication-time filters without accepting knob JSON', async () => {
  const matching = fixturePreset({
    id: 'preset-filter-match',
    title: 'Filtered Rock',
    createdAt: '2026-08-20T10:00:00.000Z',
    derivedAttributes: {
      pedalIds: ['overdrive', 'analogdelay'],
      ampId: 'crunch',
      ampModelKey: 'tone3000:123',
      cabId: 'gb4x12',
      resourceKinds: ['builtin', 'tone3000'],
    },
  });
  matching.currentRevision.resourceDependencies = [
    { kind: 'builtin' },
    { kind: 'tone3000', toneId: '123', modelId: '456' },
  ];
  const wrongCab = fixturePreset({
    id: 'preset-wrong-cab',
    title: 'Filtered Rock',
    createdAt: '2026-08-21T10:00:00.000Z',
    derivedAttributes: { ...matching.derivedAttributes, cabId: 'blue2x12' },
  });
  const wrongResource = fixturePreset({
    id: 'preset-wrong-resource',
    title: 'Filtered Rock',
    createdAt: '2026-08-20T09:00:00.000Z',
    derivedAttributes: matching.derivedAttributes,
  });
  wrongResource.currentRevision.resourceDependencies = [
    { kind: 'builtin' },
    { kind: 'tone3000', toneId: '999', modelId: '456' },
  ];
  const repository = createMemoryPublishedPresetRepository([matching, wrongCab, wrongResource], tags);
  const api = createPublishedPresetSearchApi({ presets: repository });
  const params = new URLSearchParams([
    ['tag', 'genre-rock'],
    ['pedal', 'overdrive'],
    ['amp', 'crunch'],
    ['cab', 'gb4x12'],
    ['resourceKind', 'tone3000'],
    ['resource', 'tone3000:123:456'],
    ['publishedAfter', '2026-08-20T00:00:00.000Z'],
    ['publishedBefore', '2026-08-21T00:00:00.000Z'],
  ]);
  const response = await api.fetch(new Request(
    `https://pedalboard.test/api/marketplace/search/presets?${params}`,
  ));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).items.map((item: { id: string }) => item.id), [
    matching.id,
  ]);

  const forbidden = await api.fetch(new Request(
    'https://pedalboard.test/api/marketplace/search/presets?gain=50',
  ));
  assert.equal(forbidden.status, 400);
  assert.equal((await forbidden.json()).error.code, 'invalid_preset_search');

  const malformedResource = await api.fetch(new Request(
    'https://pedalboard.test/api/marketplace/search/presets?resource=tone3000:not-a-number',
  ));
  assert.equal(malformedResource.status, 400);
});

test('opaque cursor keeps a stable continuation when newer Public content appears', async () => {
  const repository = createMemoryPublishedPresetRepository([
    fixturePreset({ id: 'preset-3', title: 'Rock Three', createdAt: '2026-08-29T03:00:00.000Z' }),
    fixturePreset({ id: 'preset-2', title: 'Rock Two', createdAt: '2026-08-29T03:00:00.000Z' }),
    fixturePreset({ id: 'preset-1', title: 'Rock One', createdAt: '2026-08-29T01:00:00.000Z' }),
    fixturePreset({
      id: 'preset-new', title: 'Rock New', visibility: 'withdrawn',
      createdAt: '2026-08-29T04:00:00.000Z',
    }),
  ], tags);
  const api = createPublishedPresetSearchApi({ presets: repository });
  const firstResponse = await api.fetch(new Request(
    'https://pedalboard.test/api/marketplace/search/presets?q=rock&limit=2',
  ));
  const first = await firstResponse.json();
  assert.deepEqual(first.items.map((item: { id: string }) => item.id), ['preset-3', 'preset-2']);
  assert.equal(typeof first.nextCursor, 'string');

  await repository.updateVisibility({
    presetId: 'preset-new',
    creatorId: demoPublishedPreset.creator.id,
    visibility: 'public',
    expectedUpdatedAt: new Date('2026-08-29T04:00:00.000Z'),
    now: new Date('2026-08-29T05:00:00.000Z'),
  });
  const secondResponse = await api.fetch(new Request(
    `https://pedalboard.test/api/marketplace/search/presets?q=rock&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
  ));
  const second = await secondResponse.json();
  assert.deepEqual(second.items.map((item: { id: string }) => item.id), ['preset-1']);
  assert.equal(second.nextCursor, null);

  const rebound = await api.fetch(new Request(
    `https://pedalboard.test/api/marketplace/search/presets?q=clean&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`,
  ));
  assert.equal(rebound.status, 400);
  assert.equal((await rebound.json()).error.code, 'invalid_search_cursor');
});
