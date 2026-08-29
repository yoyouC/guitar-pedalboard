import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client, type Pool } from 'pg';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';
import { seedPublishedPreset } from '../server/marketplace/seed.ts';
import {
  createMarketplaceHealthApi,
  probeMarketplaceStorage,
} from '../server/operations/healthApi.ts';
import { rebuildAllMarketplaceProjections } from '../server/operations/postgresProjectionRebuild.ts';
import {
  evaluateMarketplaceOperationalReport,
  nearestRankPercentile,
} from '../server/operations/verification.ts';
import {
  assertDisposableRestoreDatabase,
  assertExpectedMarketplaceBackupSource,
} from '../server/operations/restoreSafety.ts';
import { postgresCommandEnvironment } from '../server/operations/postgresCommand.ts';
import { evaluateMarketplaceAvailability } from '../server/operations/availability.ts';
import {
  assertMarketplaceBackupFactsMatch,
  evaluateMarketplaceBackupFreshness,
  isMarketplaceBackupManifest,
  marketplaceBackupArtifactPaths,
  readMarketplaceBackupFacts,
  runDailyMarketplaceBackup,
  type MarketplaceBackupFacts,
} from '../server/operations/backup.ts';

const connectionString = process.env.MARKETPLACE_TEST_DATABASE_URL;
const emptyBackupFacts: MarketplaceBackupFacts = {
  members: { count: 0, checksum: '0' },
  presets: { count: 0, checksum: '0' },
  revisions: { count: 0, checksum: '0' },
  collections: { count: 0, checksum: '0' },
};

function testBackupManifest(archivePath: string, completedAt: Date, archive = 'archive') {
  return JSON.stringify({
    formatVersion: 2,
    archive: archivePath.split('/').at(-1),
    sha256: createHash('sha256').update(archive).digest('hex'),
    source: { host: 'db.test', port: '5432', database: 'marketplace' },
    facts: emptyBackupFacts,
    startedAt: new Date(completedAt.getTime() - 1_000).toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: 1_000,
  });
}

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
    searchConvergenceMs: { publication: 800, metadata: 900 },
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
    searchConvergenceMs: { publication: 60_001, metadata: 60_002 },
  });
  assert.equal(failing.passed, false);
  assert.deepEqual(failing.failures.map((failure) => failure.metric), [
    'dataset.members', 'dataset.publicPresets', 'latency.list.p95',
    'latency.revision.p95', 'search.publication.convergence',
    'search.metadata.convergence',
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

  const queries: Array<string | { text: string; query_timeout: number }> = [];
  const releases: boolean[] = [];
  await probeMarketplaceStorage({
    async connect() {
      return {
        async query(config: string | { text: string; query_timeout: number }) {
          queries.push(config);
          return { rows: [], rowCount: 0 };
        },
        release(destroy = false) { releases.push(destroy); },
      };
    },
  }, 50);
  assert.equal(queries[0], 'BEGIN READ ONLY');
  assert.match(String(queries[1]), /set_config/);
  const probe = queries[2] as { text: string; query_timeout: number };
  assert.equal(probe.query_timeout, 50);
  assert.match(probe.text, /marketplace_published_presets/);
  assert.match(probe.text, /marketplace_published_preset_revisions/);
  assert.deepEqual(releases, [false]);
  await assert.rejects(
    () => probeMarketplaceStorage({
      async connect() {
        return {
          async query(config: string | { text: string }) {
            if (typeof config !== 'string' && config.text.includes('marketplace_published_presets')) {
              throw new Error('canceling statement due to statement timeout');
            }
            return { rows: [], rowCount: 0 };
          },
          release(destroy = false) { releases.push(destroy); },
        };
      },
    }, 1),
    /statement timeout/,
  );
  assert.equal(releases.at(-1), true);

  let lateConnectionDestroyed = false;
  await assert.rejects(
    () => probeMarketplaceStorage({
      async connect() {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          async query() { return { rows: [], rowCount: 0 }; },
          release(destroy = false) { lateConnectionDestroyed = destroy; },
        };
      },
    }, 1),
    /connection timed out/,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(lateConnectionDestroyed, true);
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
  assert.throws(() => assertDisposableRestoreDatabase(
    'postgresql://restore-user:other-secret@db.example.test:5432/marketplace_restore_drill?sslmode=require',
    'postgresql://production-user:secret@db.example.test/marketplace_restore_drill',
  ));
  assert.doesNotThrow(() => assertDisposableRestoreDatabase(
    'postgresql://db.example.test/marketplace_restore_drill',
    'postgresql://db.example.test/marketplace',
  ));
  assert.throws(() => assertExpectedMarketplaceBackupSource(
    'postgresql://db.example.test/marketplace',
    { host: 'other.example.test', port: '5432', database: 'marketplace' },
  ), /source does not match/);
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

  const failedSlot = evaluateMarketplaceAvailability({
    start: new Date('2026-08-01T00:00:00.000Z'),
    end: new Date('2026-08-01T00:10:00.000Z'),
    observations: [
      { ...base, id: 'slot-0-a', source: 'synthetic', path: '/api/marketplace/health', status: 204 },
      { ...base, id: 'slot-0-b', source: 'synthetic', path: '/api/marketplace/health', status: 204 },
      { ...base, id: 'slot-1-failure', source: 'synthetic', path: '/api/marketplace/health', status: 503,
        observedAt: '2026-08-01T00:06:00.000Z' },
    ],
  });
  assert.deepEqual(failedSlot.synthetic, { good: 1, observedSlots: 2, expectedSlots: 2 });
  assert.equal(failedSlot.availability, 0.5);
  assert.equal(failedSlot.passed, false);
});

test('backup and restore commands keep credentials out of argv and restore atomically', async () => {
  const [backup, restore] = await Promise.all([
    readFile(new URL('../scripts/marketplace-backup.ts', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/marketplace-restore-drill.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(backup, /postgresCommandEnvironment/);
  assert.match(backup, /pg_export_snapshot/);
  assert.match(backup, /runDailyMarketplaceBackup/);
  assert.doesNotMatch(backup, /--no-sync/);
  assert.match(restore, /--single-transaction/);
  assert.match(restore, /--dbname=\$\{restoreEnvironment\.PGDATABASE\}/);
  assert.match(restore, /MARKETPLACE_EXPECTED_DATABASE_URL/);
  assert.match(restore, /assertCompleteMarketplaceBackup/);
  assert.match(restore, /assertMarketplaceBackupFactsMatch/);

  assert.deepEqual(postgresCommandEnvironment(
    'postgresql://backup-user:p%40ss@db.example.test:6543/marketplace?sslmode=verify-full&application_name=backup',
  ), {
    PGHOST: 'db.example.test',
    PGPORT: '6543',
    PGDATABASE: 'marketplace',
    PGUSER: 'backup-user',
    PGPASSWORD: 'p@ss',
    PGSSLMODE: 'verify-full',
    PGAPPNAME: 'backup',
  });
});

test('daily backup uses one UTC artifact, rejects overlap, and retries cleanly after target failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'marketplace-backup-test-'));
  const now = new Date('2026-08-29T23:59:00.000Z');
  const paths = marketplaceBackupArtifactPaths(directory, now, 1234);
  assert.equal(paths.dayKey, '2026-08-29');
  assert.equal(paths.archivePath.endsWith('/marketplace-2026-08-29.dump'), true);
  assert.equal(paths.bundlePath.endsWith('/marketplace-2026-08-29.backup'), true);
  let release: () => void = () => undefined;
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  try {
    const first = runDailyMarketplaceBackup({ directory, now, processId: 1234 }, async (owned) => {
      markStarted();
      await held;
      await writeFile(owned.partialArchivePath, 'archive');
      await writeFile(owned.partialManifestPath, testBackupManifest(owned.archivePath, now));
    });
    await started;
    await assert.rejects(
      () => runDailyMarketplaceBackup({ directory, now, processId: 5678 }, async () => undefined),
      /already in progress/,
    );
    release();
    assert.equal((await first).status, 'completed');
    let repeated = false;
    const skipped = await runDailyMarketplaceBackup(
      { directory, now, processId: 9999 },
      async () => { repeated = true; },
    );
    assert.equal(skipped.status, 'skipped');
    assert.equal(repeated, false);

    const nextDay = new Date('2026-08-30T00:01:00.000Z');
    await assert.rejects(
      () => runDailyMarketplaceBackup({ directory, now: nextDay, processId: 1234 }, async () => {
        throw new Error('backup target unavailable');
      }),
      /backup target unavailable/,
    );
    const retried = await runDailyMarketplaceBackup(
      { directory, now: nextDay, processId: 5678 },
      async (owned) => {
        await writeFile(owned.partialArchivePath, 'archive');
        await writeFile(owned.partialManifestPath, testBackupManifest(owned.archivePath, nextDay));
      },
    );
    assert.equal(retried.status, 'completed');

    const corruptDay = new Date('2026-08-31T00:01:00.000Z');
    const corruptPaths = marketplaceBackupArtifactPaths(directory, corruptDay, 1234);
    await mkdir(corruptPaths.bundlePath, { recursive: true });
    await writeFile(corruptPaths.archivePath, 'partial old archive');
    await writeFile(corruptPaths.manifestPath, testBackupManifest(
      corruptPaths.archivePath, corruptDay, 'different archive',
    ));
    let recoveredCorruptManifest = false;
    const recovered = await runDailyMarketplaceBackup(
      { directory, now: corruptDay, processId: 5678 },
      async (owned) => {
        recoveredCorruptManifest = true;
        await writeFile(owned.partialArchivePath, 'replacement archive');
        await writeFile(owned.partialManifestPath, testBackupManifest(
          owned.archivePath, corruptDay, 'replacement archive',
        ));
      },
    );
    assert.equal(recovered.status, 'completed');
    assert.equal(recoveredCorruptManifest, true);
  } finally {
    release();
    await rm(directory, { recursive: true, force: true });
  }
});

test('backup manifest requires a restorable source and a real SHA-256 digest', () => {
  const valid = JSON.parse(testBackupManifest('/backup/marketplace-2026-08-29.dump', new Date(
    '2026-08-29T01:00:00.000Z',
  )));
  assert.equal(isMarketplaceBackupManifest(valid), true);
  assert.equal(isMarketplaceBackupManifest({ ...valid, source: undefined }), false);
  assert.equal(isMarketplaceBackupManifest({ ...valid, sha256: 'not-a-digest' }), false);
});

test('expired backup owners cannot publish or release a successor lease', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'marketplace-backup-fencing-'));
  const now = new Date('2026-08-29T01:00:00.000Z');
  const paths = marketplaceBackupArtifactPaths(directory, now, 1234);
  let resume: () => void = () => undefined;
  let markReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  const held = new Promise<void>((resolve) => { resume = resolve; });
  try {
    const oldOwner = runDailyMarketplaceBackup(
      { directory, now, processId: 1234, leaseDurationMs: 1 },
      async (owned) => {
        await writeFile(owned.partialArchivePath, 'old archive');
        await writeFile(owned.partialManifestPath, testBackupManifest(
          owned.archivePath, now, 'old archive',
        ));
        markReady();
        await held;
      },
    );
    await ready;
    const successor = {
      ownerToken: 'successor-owner', processId: 999_999, hostname: 'other-host',
      acquiredAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    };
    await writeFile(paths.leasePath, `${JSON.stringify(successor)}\n`);
    resume();
    await assert.rejects(oldOwner, /lost its lease/);
    assert.deepEqual(JSON.parse(await readFile(paths.leasePath, 'utf8')), successor);
    await assert.rejects(() => readFile(paths.archivePath), /ENOENT/);
    await assert.rejects(() => readFile(paths.manifestPath), /ENOENT/);
  } finally {
    resume();
    await rm(directory, { recursive: true, force: true });
  }
});

test('restore requires exact fact counts and checksums from the exported snapshot', () => {
  const facts: MarketplaceBackupFacts = {
    members: { count: 10, checksum: 'members-a' },
    presets: { count: 100, checksum: 'presets-a' },
    revisions: { count: 120, checksum: 'revisions-a' },
    collections: { count: 5, checksum: 'collections-a' },
  };
  assert.doesNotThrow(() => assertMarketplaceBackupFactsMatch(facts, structuredClone(facts)));
  assert.throws(() => assertMarketplaceBackupFactsMatch(facts, {
    ...structuredClone(facts),
    revisions: { count: 0, checksum: '0' },
  }), /facts do not match/);
});

test('backup freshness exposes the 23-hour alert and hourly catch-up contract', () => {
  const now = new Date('2026-08-30T00:00:00.000Z');
  assert.equal(evaluateMarketplaceBackupFreshness(
    '2026-08-29T02:00:00.000Z', now,
  ).fresh, true);
  const stale = evaluateMarketplaceBackupFreshness('2026-08-29T00:59:59.000Z', now);
  assert.equal(stale.fresh, false);
  assert.equal(stale.maxAgeHours, 23);
  assert.equal(evaluateMarketplaceBackupFreshness(
    '2026-08-30T00:17:00.000Z', new Date('2026-08-30T23:47:00.000Z'),
  ).fresh, true);
});

test('PostgreSQL backup facts fingerprint the actual restorable fact tables', {
  skip: connectionString ? false : 'Set MARKETPLACE_TEST_DATABASE_URL for backup facts integration',
}, async () => {
  const client = new Client({ connectionString });
  const schema = `marketplace_backup_facts_${process.pid}_${Date.now()}`;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    for (const migration of [
      '0001_published_presets.sql', '0002_authentication.sql', '0003_member_profiles.sql',
      '0004_preset_publication.sql', '0005_preset_revision_management.sql',
      '0006_preset_remix_provenance.sql', '0007_preset_collections.sql',
    ]) {
      await client.query(await readFile(new URL(
        `../server/marketplace/migrations/${migration}`, import.meta.url,
      ), 'utf8'));
    }
    await client.query('BEGIN');
    await seedPublishedPreset(client, demoPublishedPreset);
    await client.query('COMMIT');
    const before = await readMarketplaceBackupFacts(client);
    assert.deepEqual({
      members: before.members.count,
      presets: before.presets.count,
      revisions: before.revisions.count,
      collections: before.collections.count,
    }, { members: 1, presets: 1, revisions: 1, collections: 0 });
    await client.query(
      `UPDATE marketplace_published_presets SET title = 'Changed fact' WHERE id = $1`,
      [demoPublishedPreset.id],
    );
    const after = await readMarketplaceBackupFacts(client);
    assert.notEqual(after.presets.checksum, before.presets.checksum);
    assert.equal(after.revisions.checksum, before.revisions.checksum);
    await client.query(`SET TIME ZONE 'Asia/Shanghai'`);
    assert.deepEqual(await readMarketplaceBackupFacts(client), after);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
});
