import assert from 'node:assert/strict';
import test from 'node:test';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';
import {
  MarketplaceClientError,
  createMarketplaceClient,
} from '../src/marketplace/client.ts';
import type { MarketplaceTag } from '../shared/marketplace.ts';

test('official client reads the stable public preset contract', async () => {
  const client = createMarketplaceClient(async (input) => {
    assert.equal(String(input), '/api/marketplace/presets/preset-demo-crunch');
    return Response.json({ preset: demoPublishedPreset });
  });

  assert.deepEqual(await client.getPublishedPreset('preset-demo-crunch'), demoPublishedPreset);
});

test('official client distinguishes not-found, unavailable, and network failures', async () => {
  const cases = [
    {
      fetch: async () => Response.json({ error: {} }, { status: 404 }),
      code: 'not_found',
    },
    {
      fetch: async () => Response.json({ error: {} }, { status: 503 }),
      code: 'unavailable',
    },
    {
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
      code: 'network',
    },
  ] as const;

  for (const item of cases) {
    const client = createMarketplaceClient(item.fetch);
    await assert.rejects(
      () => client.getPublishedPreset('preset-demo-crunch'),
      (error) => error instanceof MarketplaceClientError && error.code === item.code,
    );
  }
});

test('official client rejects identity drift and lossy current-schema Rig data', async () => {
  const cases = [
    { ...demoPublishedPreset, id: 'a-different-preset' },
    {
      ...demoPublishedPreset,
      currentRevision: {
        ...demoPublishedPreset.currentRevision,
        rig: {
          ...demoPublishedPreset.currentRevision.rig,
          amp: { ...demoPublishedPreset.currentRevision.rig.amp, unknownControl: 42 },
        },
      },
    },
    {
      ...demoPublishedPreset,
      currentRevision: {
        ...demoPublishedPreset.currentRevision,
        payloadKind: 'opaque',
      },
    },
    {
      ...demoPublishedPreset,
      currentRevision: {
        ...demoPublishedPreset.currentRevision,
        resourceDependencies: [null],
      },
    },
    {
      ...demoPublishedPreset,
      currentRevision: {
        ...demoPublishedPreset.currentRevision,
        resourceDependencies: [
          { kind: 'builtin' },
          { kind: 'tone3000', toneId: '123' },
        ],
      },
    },
    {
      ...demoPublishedPreset,
      derivedAttributes: {
        ...demoPublishedPreset.derivedAttributes,
        ampId: 'forged-search-value',
      },
    },
  ];

  for (const preset of cases) {
    const client = createMarketplaceClient(async () => Response.json({ preset }));
    await assert.rejects(
      () => client.getPublishedPreset('preset-demo-crunch'),
      (error) => error instanceof MarketplaceClientError && error.code === 'invalid_response',
    );
  }
});

test('official client preserves a future revision as an explicit opaque payload', async () => {
  const future = {
    ...demoPublishedPreset,
    currentRevision: {
      ...demoPublishedPreset.currentRevision,
      payloadKind: 'opaque' as const,
      schemaVersion: 999,
      rig: { futureCanonicalPayload: true },
    },
  };
  const client = createMarketplaceClient(async () => Response.json({ preset: future }));
  assert.deepEqual(await client.getPublishedPreset(demoPublishedPreset.id), future);
});

test('official client lists controlled tags and publishes only the request contract', async () => {
  const tag: MarketplaceTag = {
    id: 'tone-crunch',
    dimension: 'tone',
    nameZh: 'Crunch',
    nameEn: 'Crunch',
  };
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const client = createMarketplaceClient(async (input, init) => {
    calls.push({ input: String(input), init });
    if (String(input).endsWith('/tags')) return Response.json({ tags: [tag] });
    return Response.json({ preset: demoPublishedPreset }, { status: 201 });
  });

  assert.deepEqual(await client.listAvailableTags(), [tag]);
  const request = {
    title: 'Demo Crunch',
    description: '',
    tagIds: ['tone-crunch'],
    schemaVersion: 5,
    rig: demoPublishedPreset.currentRevision.rig,
  };
  assert.deepEqual(await client.publishPreset(request), demoPublishedPreset);
  assert.equal(calls[1].input, '/api/marketplace/presets');
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), request);
});

test('official client preserves shared server publication field errors', async () => {
  const client = createMarketplaceClient(async () => Response.json({
    error: {
      code: 'invalid_publication',
      message: 'Published preset is invalid',
      fields: { title: '标题最多 80 个字符' },
    },
  }, { status: 400 }));

  await assert.rejects(
    () => client.publishPreset({
      title: 'x'.repeat(81),
      description: '',
      tagIds: ['tone-crunch'],
      schemaVersion: 5,
      rig: demoPublishedPreset.currentRevision.rig,
    }),
    (error) => error instanceof MarketplaceClientError
      && error.code === 'invalid_publication'
      && error.fields?.title === '标题最多 80 个字符',
  );
});

test('published metadata counts Unicode characters consistently with server validation', async () => {
  const unicodePreset = {
    ...demoPublishedPreset,
    title: '🎸'.repeat(80),
    description: '🎶'.repeat(2_000),
  };
  const client = createMarketplaceClient(async () => Response.json({ preset: unicodePreset }));

  assert.equal((await client.getPublishedPreset(unicodePreset.id)).title, unicodePreset.title);
});

test('official client manages metadata, immutable revisions, rollback, and visibility with concurrency tokens', async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const revisionView = {
    id: demoPublishedPreset.id,
    title: demoPublishedPreset.title,
    description: demoPublishedPreset.description,
    visibility: 'public' as const,
    creator: demoPublishedPreset.creator,
    tags: demoPublishedPreset.tags,
    revision: demoPublishedPreset.currentRevision,
    currentRevisionId: demoPublishedPreset.currentRevision.id,
    createdAt: demoPublishedPreset.createdAt,
    updatedAt: demoPublishedPreset.updatedAt,
  };
  const client = createMarketplaceClient(async (input, init) => {
    calls.push({ input: String(input), init });
    if (String(input).endsWith('/revisions/revision-demo-crunch-1')) {
      return Response.json({ preset: revisionView });
    }
    if (String(input).endsWith('/revisions') && init?.method !== 'POST') {
      return Response.json({ revisions: [{
        id: demoPublishedPreset.currentRevision.id,
        createdAt: demoPublishedPreset.currentRevision.createdAt,
        isCurrent: true,
      }] });
    }
    return Response.json({ preset: demoPublishedPreset });
  });

  assert.deepEqual(
    await client.getPublishedPresetRevision(demoPublishedPreset.id, 'revision-demo-crunch-1'),
    revisionView,
  );
  assert.equal((await client.listPublishedPresetRevisions(demoPublishedPreset.id)).length, 1);
  await client.updatePublishedPresetMetadata(demoPublishedPreset.id, {
    title: 'New title',
    description: '',
    tagIds: ['tone-crunch'],
    expectedUpdatedAt: demoPublishedPreset.updatedAt,
  });
  await client.appendPublishedPresetRevision(demoPublishedPreset.id, {
    schemaVersion: 5,
    rig: demoPublishedPreset.currentRevision.rig,
    expectedUpdatedAt: demoPublishedPreset.updatedAt,
  });
  await client.restorePublishedPresetRevision(
    demoPublishedPreset.id,
    demoPublishedPreset.currentRevision.id,
    { expectedUpdatedAt: demoPublishedPreset.updatedAt },
  );
  await client.updatePublishedPresetVisibility(demoPublishedPreset.id, {
    visibility: 'unlisted',
    expectedUpdatedAt: demoPublishedPreset.updatedAt,
  });

  assert.deepEqual(calls.slice(2).map(({ input, init }) => [input, init?.method]), [
    [`/api/marketplace/presets/${demoPublishedPreset.id}/metadata`, 'PATCH'],
    [`/api/marketplace/presets/${demoPublishedPreset.id}/revisions`, 'POST'],
    [`/api/marketplace/presets/${demoPublishedPreset.id}/revisions/${demoPublishedPreset.currentRevision.id}/restore`, 'POST'],
    [`/api/marketplace/presets/${demoPublishedPreset.id}/visibility`, 'PATCH'],
  ]);
});

test('official client exposes recoverable preset concurrency state', async () => {
  const current = {
    updatedAt: demoPublishedPreset.updatedAt,
    currentRevisionId: demoPublishedPreset.currentRevision.id,
    visibility: 'public',
  };
  const client = createMarketplaceClient(async () => Response.json({
    error: {
      code: 'preset_update_conflict',
      message: 'Preset changed since it was loaded',
      current,
    },
  }, { status: 409 }));

  await assert.rejects(
    () => client.updatePublishedPresetVisibility(demoPublishedPreset.id, {
      visibility: 'unlisted',
      expectedUpdatedAt: '2020-01-01T00:00:00.000Z',
    }),
    (error) => error instanceof MarketplaceClientError
      && error.code === 'update_conflict'
      && error.current?.currentRevisionId === demoPublishedPreset.currentRevision.id,
  );
});
