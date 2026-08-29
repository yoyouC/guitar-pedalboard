import assert from 'node:assert/strict';
import test from 'node:test';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';
import type { PresetCollection } from '../shared/marketplace.ts';
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

test('official client reads the revision compatibility contract', async () => {
  const client = createMarketplaceClient(async (input) => {
    assert.match(String(input), /\/compatibility$/);
    return Response.json({
      compatibility: {
        status: 'incompatible',
        blockers: [{
          kind: 'tone3000', dependencyKey: 'tone3000:42:9001',
          availability: 'unavailable', reason: 'deleted',
        }],
      },
    });
  });
  assert.equal((await client.getPublishedPresetRevisionCompatibility(
    demoPublishedPreset.id,
    demoPublishedPreset.currentRevision.id,
  )).status, 'incompatible');
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

test('official client exposes verification and retry feedback without changing the publication request', async () => {
  const request = {
    title: 'Keep This Draft', description: 'Unsaved editor input.', tagIds: ['tone-crunch'],
    schemaVersion: 5 as const, rig: demoPublishedPreset.currentRevision.rig,
  };
  const verification = createMarketplaceClient(async (_input, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), request);
    return Response.json({ error: {
      code: 'email_verification_required', verificationUrl: '/login?verify=email',
    } }, { status: 403 });
  });
  await assert.rejects(
    () => verification.publishPreset(request),
    (error) => error instanceof MarketplaceClientError
      && error.code === 'verification_required'
      && error.verificationUrl === '/login?verify=email',
  );

  const limited = createMarketplaceClient(async () => Response.json({ error: {
    code: 'write_rate_limited', operation: 'publish', retryAt: '2026-08-29T10:01:00.000Z',
  } }, { status: 429 }));
  await assert.rejects(
    () => limited.publishPreset(request),
    (error) => error instanceof MarketplaceClientError
      && error.code === 'rate_limited'
      && error.retryAt === '2026-08-29T10:01:00.000Z',
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

test('official client reads the private My Tones list across owner-visible states', async () => {
  const tones = [
    demoPublishedPreset,
    { ...demoPublishedPreset, id: 'tone-unlisted', visibility: 'unlisted' as const },
    { ...demoPublishedPreset, id: 'tone-withdrawn', visibility: 'withdrawn' as const },
  ];
  let requested = '';
  const client = createMarketplaceClient(async (input) => {
    requested = String(input);
    return Response.json({ tones });
  });
  assert.deepEqual(await client.listManagedPublishedPresets(), tones);
  assert.equal(requested, '/api/marketplace/me/tones');
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

test('official client reads, creates, manages, and updates fixed-revision collections', async () => {
  const collection: PresetCollection = {
    id: 'collection-stage-tones',
    title: 'Stage Tones',
    description: '',
    visibility: 'public',
    creator: demoPublishedPreset.creator,
    tags: demoPublishedPreset.tags,
    items: [{
      position: 0,
      presetId: demoPublishedPreset.id,
      revisionId: demoPublishedPreset.currentRevision.id,
      availability: 'available',
      title: demoPublishedPreset.title,
      creator: demoPublishedPreset.creator,
    }],
    createdAt: demoPublishedPreset.createdAt,
    updatedAt: demoPublishedPreset.updatedAt,
  };
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const client = createMarketplaceClient(async (input, init) => {
    calls.push({ input: String(input), init });
    return Response.json(
      String(input) === '/api/marketplace/me/collections'
        ? { collections: [collection] }
        : { collection },
      { status: init?.method === 'POST' ? 201 : 200 },
    );
  });

  assert.deepEqual(await client.getPresetCollection(collection.id), collection);
  assert.deepEqual(await client.getManagedPresetCollection(collection.id), collection);
  assert.deepEqual(await client.listManagedPresetCollections(), [collection]);
  await client.createPresetCollection({
    title: collection.title,
    description: collection.description,
    tagIds: collection.tags.map((tag) => tag.id),
    visibility: 'unlisted',
  });
  await client.updatePresetCollection(collection.id, {
    title: collection.title,
    description: collection.description,
    tagIds: collection.tags.map((tag) => tag.id),
    visibility: 'public',
    items: collection.items.map(({ presetId, revisionId }) => ({ presetId, revisionId })),
    expectedUpdatedAt: collection.updatedAt,
  });

  assert.deepEqual(calls.map(({ input, init }) => [input, init?.method]), [
    [`/api/marketplace/collections/${collection.id}`, undefined],
    [`/api/marketplace/collections/${collection.id}/manage`, undefined],
    ['/api/marketplace/me/collections', undefined],
    ['/api/marketplace/collections', 'POST'],
    [`/api/marketplace/collections/${collection.id}`, 'PATCH'],
  ]);
});

test('official client rejects a collection response that leaks unavailable item content', async () => {
  const leaked = {
    id: 'collection-leaked',
    title: 'Leaked',
    description: '',
    visibility: 'public',
    creator: demoPublishedPreset.creator,
    tags: demoPublishedPreset.tags,
    items: [{
      position: 0,
      presetId: demoPublishedPreset.id,
      revisionId: demoPublishedPreset.currentRevision.id,
      availability: 'unavailable',
      title: demoPublishedPreset.title,
      creator: demoPublishedPreset.creator,
      rig: demoPublishedPreset.currentRevision.rig,
    }],
    createdAt: demoPublishedPreset.createdAt,
    updatedAt: demoPublishedPreset.updatedAt,
  };
  const client = createMarketplaceClient(async () => Response.json({ collection: leaked }));
  await assert.rejects(
    () => client.getPresetCollection(leaked.id),
    (error) => error instanceof MarketplaceClientError && error.code === 'invalid_response',
  );
});

test('official client sends structured preset search and validates the public result projection', async () => {
  const page = {
    items: [{
      id: demoPublishedPreset.id,
      title: demoPublishedPreset.title,
      description: demoPublishedPreset.description,
      creator: demoPublishedPreset.creator,
      tags: demoPublishedPreset.tags,
      derivedAttributes: demoPublishedPreset.derivedAttributes,
      resourceDependencies: demoPublishedPreset.currentRevision.resourceDependencies,
      isRemix: false,
      createdAt: demoPublishedPreset.createdAt,
      updatedAt: demoPublishedPreset.updatedAt,
    }],
    nextCursor: 'opaque-next',
  };
  let requested = '';
  const client = createMarketplaceClient(async (input) => {
    requested = String(input);
    return Response.json(page);
  });
  assert.deepEqual(await client.searchPublishedPresets({
    text: 'rock',
    tagIds: ['genre-rock'],
    pedalIds: ['overdrive'],
    ampIds: ['crunch'],
    cabIds: ['gb4x12'],
    resourceKinds: ['builtin'],
    resourceDependencyKeys: ['tone3000:123:456'],
    publishedAfter: '2026-08-01T00:00:00.000Z',
    publishedBefore: '2026-08-31T00:00:00.000Z',
    limit: 12,
    cursor: 'opaque-current',
  }), page);
  assert.equal(requested, '/api/marketplace/search/presets?'
    + 'q=rock&tag=genre-rock&pedal=overdrive&amp=crunch&cab=gb4x12&resourceKind=builtin'
    + '&resource=tone3000%3A123%3A456'
    + '&publishedAfter=2026-08-01T00%3A00%3A00.000Z'
    + '&publishedBefore=2026-08-31T00%3A00%3A00.000Z&limit=12&cursor=opaque-current');

  const malformed = createMarketplaceClient(async () => Response.json({
    ...page,
    items: [{ ...page.items[0], rig: demoPublishedPreset.currentRevision.rig }],
  }));
  await assert.rejects(
    () => malformed.searchPublishedPresets({ text: 'rock' }),
    (error) => error instanceof MarketplaceClientError && error.code === 'invalid_response',
  );
});

test('official client keeps collection and creator discovery cursors on independent endpoints', async () => {
  const collectionPage = {
    items: [{
      id: 'collection-rock',
      title: 'Rock Stage',
      description: 'Stage tones',
      creator: demoPublishedPreset.creator,
      tags: demoPublishedPreset.tags,
      url: '/marketplace/collections/collection-rock',
      createdAt: demoPublishedPreset.createdAt,
      updatedAt: demoPublishedPreset.updatedAt,
    }],
    nextCursor: 'collection-next',
  };
  const creatorPage = {
    items: [{
      id: demoPublishedPreset.creator.id,
      handle: demoPublishedPreset.creator.handle,
      displayName: demoPublishedPreset.creator.displayName,
      bio: 'Guitar tones',
      avatarUrl: null,
      url: `/creators/id/${demoPublishedPreset.creator.id}`,
      createdAt: demoPublishedPreset.createdAt,
    }],
    nextCursor: 'creator-next',
  };
  const calls: string[] = [];
  const client = createMarketplaceClient(async (input) => {
    calls.push(String(input));
    return Response.json(String(input).includes('/collections?') ? collectionPage : creatorPage);
  });

  assert.deepEqual(await client.searchPresetCollections({
    text: 'rock', limit: 8, cursor: 'collection-current',
  }), collectionPage);
  assert.deepEqual(await client.searchCreators({
    text: 'ada', limit: 6, cursor: 'creator-current',
  }), creatorPage);
  assert.deepEqual(calls, [
    '/api/marketplace/search/collections?q=rock&limit=8&cursor=collection-current',
    '/api/marketplace/search/creators?q=ada&limit=6&cursor=creator-current',
  ]);

  const leaked = createMarketplaceClient(async () => Response.json({
    ...collectionPage,
    items: [{ ...collectionPage.items[0], items: [{ title: 'private body' }] }],
  }));
  await assert.rejects(
    () => leaked.searchPresetCollections({ text: 'rock' }),
    (error) => error instanceof MarketplaceClientError && error.code === 'invalid_response',
  );
});

test('official client reads and mutates likes without accepting private trajectory drift', async () => {
  const calls: Array<{ path: string; method?: string }> = [];
  const summary = {
    id: demoPublishedPreset.id,
    title: demoPublishedPreset.title,
    creator: demoPublishedPreset.creator,
    likeCount: 3,
  };
  const client = createMarketplaceClient(async (input, init) => {
    const path = String(input);
    calls.push({ path, method: init?.method });
    if (path === '/api/marketplace/me/likes') {
      return Response.json({
        likes: { presets: [{ ...summary, likedAt: demoPublishedPreset.updatedAt }], collections: [] },
      });
    }
    if (path.startsWith('/api/marketplace/popular/') || path.startsWith('/api/marketplace/trending/')) {
      return Response.json({ items: [summary], nextCursor: 'popular-next' });
    }
    return Response.json({ state: { liked: init?.method !== 'DELETE', canLike: true, likeCount: 3 } });
  });

  assert.equal((await client.getLikeState('preset', demoPublishedPreset.id)).likeCount, 3);
  assert.equal((await client.setLike('preset', demoPublishedPreset.id, true)).liked, true);
  assert.equal((await client.setLike('preset', demoPublishedPreset.id, false)).liked, false);
  assert.deepEqual((await client.getMyLikes()).presets.map((item) => item.id), [demoPublishedPreset.id]);
  assert.deepEqual((await client.listPopular('preset', { limit: 1, cursor: 'current' })).items, [summary]);
  assert.deepEqual((await client.listTrending('collection', { limit: 2 })).items, [summary]);
  assert.deepEqual(calls, [
    { path: `/api/marketplace/likes/presets/${demoPublishedPreset.id}`, method: 'GET' },
    { path: `/api/marketplace/likes/presets/${demoPublishedPreset.id}`, method: 'PUT' },
    { path: `/api/marketplace/likes/presets/${demoPublishedPreset.id}`, method: 'DELETE' },
    { path: '/api/marketplace/me/likes', method: undefined },
    { path: '/api/marketplace/popular/presets?limit=1&cursor=current', method: undefined },
    { path: '/api/marketplace/trending/collections?limit=2', method: undefined },
  ]);

  const leaked = createMarketplaceClient(async () => Response.json({
    items: [{ ...summary, likedAt: demoPublishedPreset.updatedAt }], nextCursor: null,
  }));
  await assert.rejects(
    () => leaked.listTrending('preset'),
    (error) => error instanceof MarketplaceClientError && error.code === 'invalid_response',
  );
});

test('official client submits moderation requests, validates author cases, and preserves governance errors', async () => {
  const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
  const moderationCase = {
    actionId: 'action-hide-1',
    targetKind: 'preset',
    targetId: demoPublishedPreset.id,
    action: 'hide',
    reason: 'Confirmed impersonation.',
    createdAt: '2026-08-29T14:00:00.000Z',
    appeal: null,
  } as const;
  const client = createMarketplaceClient(async (input, init) => {
    calls.push({
      path: String(input),
      method: init?.method,
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
    });
    if (String(input) === '/api/marketplace/me/moderation') {
      return Response.json({ cases: [moderationCase] });
    }
    if (String(input) === '/api/marketplace/reports') {
      return Response.json({ report: { id: 'report-receipt-1' } }, { status: 201 });
    }
    return new Response(null, { status: 201 });
  });

  assert.deepEqual(await client.submitReport({
    targetKind: 'preset', targetId: demoPublishedPreset.id,
    reason: 'impersonation', details: 'The author identity is misleading.',
  }), { id: 'report-receipt-1' });
  await client.submitInfringementNotice({
    claimantName: 'Rights Holder', claimantEmail: 'rights@example.test',
    targetKind: 'preset', targetId: demoPublishedPreset.id,
    rightsStatement: 'I own the identified work and request its review.', goodFaith: true,
  });
  assert.deepEqual(await client.getMyModerationCases(), [moderationCase]);
  await client.submitModerationAppeal('action-hide-1', 'The attribution is accurate.');
  assert.deepEqual(calls, [
    {
      path: '/api/marketplace/reports', method: 'POST',
      body: {
        targetKind: 'preset', targetId: demoPublishedPreset.id,
        reason: 'impersonation', details: 'The author identity is misleading.',
      },
    },
    {
      path: '/api/marketplace/infringement-notices', method: 'POST',
      body: {
        claimantName: 'Rights Holder', claimantEmail: 'rights@example.test',
        targetKind: 'preset', targetId: demoPublishedPreset.id,
        rightsStatement: 'I own the identified work and request its review.', goodFaith: true,
      },
    },
    { path: '/api/marketplace/me/moderation', method: undefined },
    {
      path: '/api/marketplace/moderation/appeals', method: 'POST',
      body: { actionId: 'action-hide-1', statement: 'The attribution is accurate.' },
    },
  ]);

  const malformed = createMarketplaceClient(async () => Response.json({
    cases: [{ ...moderationCase, actorAuthUserId: 'auth-admin' }],
  }));
  await assert.rejects(
    () => malformed.getMyModerationCases(),
    (error) => error instanceof MarketplaceClientError && error.code === 'invalid_response',
  );

  const duplicate = createMarketplaceClient(async () => Response.json({
    error: { code: 'duplicate_report', message: 'duplicate' },
  }, { status: 409 }));
  await assert.rejects(
    () => duplicate.submitReport({
      targetKind: 'preset', targetId: demoPublishedPreset.id,
      reason: 'spam', details: 'Already reported.',
    }),
    (error) => error instanceof MarketplaceClientError
      && error.code === 'invalid_update'
      && error.message === '你已经举报过这个内容。',
  );

  const banned = createMarketplaceClient(async () => Response.json({
    error: { code: 'member_banned', message: 'banned' },
  }, { status: 403 }));
  await assert.rejects(
    () => banned.submitModerationAppeal('action-hide-1', 'Please review.'),
    (error) => error instanceof MarketplaceClientError
      && error.code === 'forbidden'
      && error.message === '账号已被禁止执行社区写操作。',
  );
});
