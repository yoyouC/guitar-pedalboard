import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { Pool } from 'pg';
import { createMarketplaceHealthApi } from '../server/operations/healthApi.ts';
import { rebuildAllMarketplaceProjections } from '../server/operations/postgresProjectionRebuild.ts';
import {
  evaluateMarketplaceOperationalReport,
  nearestRankPercentile,
} from '../server/operations/verification.ts';
import { assertDisposableRestoreDatabase } from '../server/operations/restoreSafety.ts';
import { evaluateMarketplaceAvailability } from '../server/operations/availability.ts';

test('operations report enforces representative scale and every published latency target', () => {
  assert.equal(nearestRankPercentile([50, 10, 40, 20, 30], 95), 50);
  const passing = evaluateMarketplaceOperationalReport({
    dataset: { members: 10_000, publicPresets: 100_000 },
    durationsMs: {
      list: [100, 120, 140, 160, 180, 200, 220, 240, 260, 300],
      detail: [50, 55, 60, 65, 70, 75, 80, 85, 90, 95],
      search: [200, 210, 220, 230, 240, 250, 260, 270, 280, 300],
      revision: [500, 600, 700, 800, 900, 1_000, 1_100, 1_200, 1_300, 1_500],
    },
    searchConvergenceMs: 900,
  });
  assert.equal(passing.passed, true);
  assert.deepEqual(passing.targets, {
    readP95Ms: 500, revisionP95Ms: 2_000, searchConvergenceMs: 60_000,
  });

  const failing = evaluateMarketplaceOperationalReport({
    dataset: { members: 9_999, publicPresets: 99_999 },
    durationsMs: {
      list: [501], detail: [500], search: [500], revision: [2_001],
    },
    searchConvergenceMs: 60_001,
  });
  assert.equal(failing.passed, false);
  assert.deepEqual(failing.failures.map((failure) => failure.metric), [
    'dataset.members', 'dataset.publicPresets', 'latency.list.p95',
    'latency.revision.p95', 'search.convergence',
  ]);
});

test('health endpoint probes only first-party marketplace storage and never caches failure', async () => {
  let probes = 0;
  const healthy = createMarketplaceHealthApi({ async probe() { probes += 1; } });
  const response = await healthy.fetch(new Request('https://pedalboard.test/api/marketplace/health'));
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(probes, 1);

  const unhealthy = createMarketplaceHealthApi({ async probe() { throw new Error('database down'); } });
  const failed = await unhealthy.fetch(new Request('https://pedalboard.test/api/marketplace/health'));
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), {
    error: { code: 'marketplace_unavailable', message: 'Marketplace is temporarily unavailable' },
  });
  assert.equal((await unhealthy.fetch(new Request('https://pedalboard.test/tone3000/health'))).status, 404);
});

test('all rebuildable projections commit together and roll back on an injected failure', async () => {
  const queries: string[] = [];
  const client = {
    async query(text: string) {
      queries.push(text);
      if (text.includes('marketplace_trending_rebuilds')) throw new Error('trending unavailable');
      if (text.includes("nextval('marketplace_like_rank_version_seq')")) {
        return { rows: [{ rank_version: '1' }], rowCount: 1 };
      }
      if (text.includes("nextval('marketplace_trending_rank_version_seq')")) {
        return { rows: [{ rank_version: '1' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const pool = { async connect() { return client; } } as unknown as Pool;
  await assert.rejects(() => rebuildAllMarketplaceProjections(pool, {
    now: new Date('2026-08-29T00:00:00.000Z'),
    trendingPolicy: { windowHours: 168, halfLifeHours: 48 },
  }), /trending unavailable/);
  assert.equal(queries[0], 'BEGIN');
  assert.ok(queries.some((query) => query.includes('marketplace_published_preset_search_projection')));
  assert.ok(queries.some((query) => query.includes('marketplace_preset_like_counts')));
  assert.equal(queries.at(-1), 'ROLLBACK');
  assert.equal(queries.includes('COMMIT'), false);
});

test('restore drill refuses production or ambiguously named databases', () => {
  assert.throws(() => assertDisposableRestoreDatabase(
    'postgresql://db.example.test/marketplace',
    'postgresql://db.example.test/marketplace',
  ));
  assert.throws(() => assertDisposableRestoreDatabase(
    'postgresql://db.example.test/staging',
    'postgresql://db.example.test/marketplace',
  ));
  assert.doesNotThrow(() => assertDisposableRestoreDatabase(
    'postgresql://db.example.test/marketplace_restore_drill',
    'postgresql://db.example.test/marketplace',
  ));
});

test('monthly availability is reproducible, deduplicated, and excludes TONE3000', () => {
  const base = {
    environment: 'production' as const,
    observedAt: '2026-08-01T00:01:00.000Z',
  };
  const report = evaluateMarketplaceAvailability({
    start: new Date('2026-08-01T00:00:00.000Z'),
    end: new Date('2026-08-01T00:10:00.000Z'),
    observations: [
      { ...base, id: 'request-1', source: 'request', path: '/api/marketplace/presets', status: 200 },
      { ...base, id: 'request-1', source: 'request', path: '/api/marketplace/presets', status: 500 },
      { ...base, id: 'external', source: 'request', path: '/api/marketplace/tone3000/download', status: 500 },
      { ...base, id: 'probe-1', source: 'synthetic', path: '/api/marketplace/health', status: 204 },
      { ...base, id: 'probe-2', source: 'synthetic', path: '/api/marketplace/health', status: 204,
        observedAt: '2026-08-01T00:06:00.000Z' },
    ],
  });
  assert.deepEqual(report.requests, { good: 1, total: 1 });
  assert.deepEqual(report.synthetic, { good: 2, observedSlots: 2, expectedSlots: 2 });
  assert.equal(report.passed, true);
});

test('backup and restore commands keep credentials out of argv and restore atomically', async () => {
  const [backup, restore] = await Promise.all([
    readFile(new URL('../scripts/marketplace-backup.ts', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/marketplace-restore-drill.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(backup, /PGDATABASE: connectionString/);
  assert.doesNotMatch(backup, /--no-sync/);
  assert.match(restore, /--single-transaction/);
  assert.match(restore, /checksum does not match/);
});
