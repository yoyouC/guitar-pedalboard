import assert from 'node:assert/strict';
import test from 'node:test';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';
import {
  MarketplaceClientError,
  createMarketplaceClient,
} from '../src/marketplace/client.ts';

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
  ];

  for (const preset of cases) {
    const client = createMarketplaceClient(async () => Response.json({ preset }));
    await assert.rejects(
      () => client.getPublishedPreset('preset-demo-crunch'),
      (error) => error instanceof MarketplaceClientError && error.code === 'invalid_response',
    );
  }
});
