import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { QueryResultRow } from 'pg';
import type { PostgresQueryable } from '../marketplace/postgresRepository.ts';
import {
  isMarketplaceDatabaseIdentity,
  type MarketplaceDatabaseIdentity,
} from './restoreSafety.ts';

const DEFAULT_BACKUP_MAX_AGE_MS = 23 * 60 * 60 * 1_000;

export interface MarketplaceBackupFactSummary {
  count: number;
  checksum: string;
}

export interface MarketplaceBackupFacts {
  members: MarketplaceBackupFactSummary;
  presets: MarketplaceBackupFactSummary;
  revisions: MarketplaceBackupFactSummary;
  collections: MarketplaceBackupFactSummary;
}

export interface MarketplaceBackupArtifactPaths {
  dayKey: string;
  bundlePath: string;
  archivePath: string;
  manifestPath: string;
  partialBundlePath: string;
  partialArchivePath: string;
  partialManifestPath: string;
}

export interface MarketplaceBackupManifest {
  formatVersion: 2;
  archive: string;
  sha256: string;
  source: MarketplaceDatabaseIdentity;
  facts: MarketplaceBackupFacts;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export interface MarketplaceBackupMutexLease {
  fence(): Promise<void>;
  release(): Promise<void>;
}

export interface MarketplaceBackupMutex {
  tryAcquire(dayKey: string): Promise<MarketplaceBackupMutexLease | null>;
}

interface MarketplaceBackupPostgresClient extends PostgresQueryable {
  release(destroy?: boolean): void;
}

export function createPostgresMarketplaceBackupMutex(database: {
  connect(): Promise<MarketplaceBackupPostgresClient>;
}): MarketplaceBackupMutex {
  return {
    async tryAcquire(dayKey) {
      const client = await database.connect();
      const key = `marketplace-backup:${dayKey}`;
      try {
        const acquired = await client.query<{ acquired: boolean }>(
          `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired`,
          [key],
        );
        if (!acquired.rows[0]?.acquired) {
          client.release();
          return null;
        }
      } catch (cause) {
        client.release(true);
        throw cause;
      }

      let holdCount = 1;
      let released = false;
      return {
        async fence() {
          if (released) throw new Error('Marketplace backup mutex was already released');
          const fenced = await client.query<{ acquired: boolean }>(
            `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired`,
            [key],
          );
          if (!fenced.rows[0]?.acquired) {
            throw new Error('Marketplace backup lost its publication mutex');
          }
          holdCount += 1;
        },
        async release() {
          if (released) return;
          released = true;
          let destroy = false;
          try {
            while (holdCount > 0) {
              const unlocked = await client.query<{ unlocked: boolean }>(
                `SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked`,
                [key],
              );
              if (!unlocked.rows[0]?.unlocked) {
                throw new Error('Marketplace backup publication mutex was not held');
              }
              holdCount -= 1;
            }
          } catch (cause) {
            destroy = true;
            throw cause;
          } finally {
            client.release(destroy);
          }
        },
      };
    },
  };
}

export function evaluateMarketplaceBackupFreshness(
  completedAt: string,
  now: Date,
  maxAgeMs = DEFAULT_BACKUP_MAX_AGE_MS,
): { fresh: boolean; ageHours: number; maxAgeHours: number } {
  const completedAtMs = Date.parse(completedAt);
  const ageMs = now.getTime() - completedAtMs;
  if (!Number.isFinite(completedAtMs) || ageMs < 0) {
    return { fresh: false, ageHours: Number.NaN, maxAgeHours: maxAgeMs / 3_600_000 };
  }
  const completedUtcDay = new Date(completedAtMs).toISOString().slice(0, 10);
  return {
    fresh: completedUtcDay === now.toISOString().slice(0, 10) || ageMs <= maxAgeMs,
    ageHours: ageMs / 3_600_000,
    maxAgeHours: maxAgeMs / 3_600_000,
  };
}

export function marketplaceBackupArtifactPaths(
  directory: string,
  now: Date,
  processId: number,
): MarketplaceBackupArtifactPaths {
  const root = resolve(directory);
  const dayKey = now.toISOString().slice(0, 10);
  const bundlePath = resolve(root, `marketplace-${dayKey}.backup`);
  const partialBundlePath = resolve(root, `.marketplace-${dayKey}.${processId}.backup.partial`);
  const archiveName = `marketplace-${dayKey}.dump`;
  const archivePath = resolve(bundlePath, archiveName);
  const manifestPath = `${archivePath}.json`;
  return {
    dayKey,
    bundlePath,
    archivePath,
    manifestPath,
    partialBundlePath,
    partialArchivePath: resolve(partialBundlePath, archiveName),
    partialManifestPath: resolve(partialBundlePath, `${archiveName}.json`),
  };
}

export async function runDailyMarketplaceBackup(
  input: {
    directory: string;
    now: Date;
    processId: number;
    mutex: MarketplaceBackupMutex;
  },
  action: (paths: MarketplaceBackupArtifactPaths) => Promise<void>,
): Promise<{ status: 'completed' | 'skipped'; paths: MarketplaceBackupArtifactPaths }> {
  await mkdir(resolve(input.directory), { recursive: true });
  const paths = marketplaceBackupArtifactPaths(input.directory, input.now, input.processId);
  if (await isCompletedBackup(paths)) return { status: 'skipped', paths };
  const lease = await input.mutex.tryAcquire(paths.dayKey);
  if (!lease) throw new Error('Marketplace backup is already in progress');
  try {
    if (await isCompletedBackup(paths)) return { status: 'skipped', paths };
    await rm(paths.bundlePath, { recursive: true, force: true });
    await rm(paths.partialBundlePath, { recursive: true, force: true });
    await mkdir(paths.partialBundlePath, { recursive: false, mode: 0o700 });
    try {
      await action(paths);
      const manifest = await readMarketplaceBackupManifest(paths.partialManifestPath);
      await assertCompleteMarketplaceBackup(
        paths.partialArchivePath, manifest, basename(paths.archivePath),
      );
      await lease.fence();
      await rename(paths.partialBundlePath, paths.bundlePath);
      return { status: 'completed', paths };
    } finally {
      await rm(paths.partialBundlePath, { recursive: true, force: true });
    }
  } finally {
    await releaseLease(lease);
  }
}

async function releaseLease(
  lease: MarketplaceBackupMutexLease,
): Promise<void> {
  await lease.release();
}

async function isCompletedBackup(paths: MarketplaceBackupArtifactPaths): Promise<boolean> {
  try {
    const manifest = await readMarketplaceBackupManifest(paths.manifestPath);
    await assertCompleteMarketplaceBackup(paths.archivePath, manifest, basename(paths.archivePath));
    return true;
  } catch {
    return false;
  }
}

export function isMarketplaceBackupManifest(value: unknown): value is MarketplaceBackupManifest {
  if (!value || typeof value !== 'object') return false;
  const manifest = value as Record<string, unknown>;
  return manifest.formatVersion === 2
    && typeof manifest.archive === 'string' && manifest.archive.length > 0
    && typeof manifest.sha256 === 'string' && /^[a-f\d]{64}$/i.test(manifest.sha256)
    && isMarketplaceDatabaseIdentity(manifest.source)
    && isMarketplaceBackupFacts(manifest.facts)
    && typeof manifest.startedAt === 'string' && Number.isFinite(Date.parse(manifest.startedAt))
    && typeof manifest.completedAt === 'string' && Number.isFinite(Date.parse(manifest.completedAt))
    && typeof manifest.durationMs === 'number' && Number.isFinite(manifest.durationMs)
    && manifest.durationMs >= 0;
}

export async function readMarketplaceBackupManifest(path: string): Promise<MarketplaceBackupManifest> {
  const manifest: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!isMarketplaceBackupManifest(manifest)) throw new Error('Backup manifest is invalid');
  return manifest;
}

export async function assertCompleteMarketplaceBackup(
  archivePath: string,
  manifest: MarketplaceBackupManifest,
  expectedArchive = basename(archivePath),
): Promise<void> {
  if (manifest.archive !== expectedArchive) throw new Error('Backup manifest names the wrong archive');
  await access(archivePath);
  if (await marketplaceFileSha256(archivePath) !== manifest.sha256) {
    throw new Error('Backup archive checksum does not match its manifest');
  }
}

export async function marketplaceFileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolveDigest, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolveDigest);
  });
  return hash.digest('hex');
}

export async function readMarketplaceBackupFacts(
  database: PostgresQueryable,
): Promise<MarketplaceBackupFacts> {
  const result = await database.query<QueryResultRow & { facts: MarketplaceBackupFacts }>(
    `WITH settings AS MATERIALIZED (
       SELECT set_config('TimeZone', 'UTC', true)
     )
     SELECT jsonb_build_object(
       'members', (
         SELECT jsonb_build_object(
           'count', count(*),
           'checksum', COALESCE(bit_xor(hashtextextended(to_jsonb(member_fact)::text, 0)), 0)::text
         ) FROM marketplace_members AS member_fact
       ),
       'presets', (
         SELECT jsonb_build_object(
           'count', count(*),
           'checksum', COALESCE(bit_xor(hashtextextended(to_jsonb(preset_fact)::text, 0)), 0)::text
         ) FROM marketplace_published_presets AS preset_fact
       ),
       'revisions', (
         SELECT jsonb_build_object(
           'count', count(*),
           'checksum', COALESCE(bit_xor(hashtextextended(to_jsonb(revision_fact)::text, 0)), 0)::text
         ) FROM marketplace_published_preset_revisions AS revision_fact
       ),
       'collections', (
         SELECT jsonb_build_object(
           'count', count(*),
           'checksum', COALESCE(bit_xor(hashtextextended(to_jsonb(collection_fact)::text, 0)), 0)::text
         ) FROM marketplace_preset_collections AS collection_fact
       )
     ) AS facts
     FROM settings`,
  );
  const facts = result.rows[0]?.facts;
  if (!isMarketplaceBackupFacts(facts)) throw new Error('Marketplace backup facts are invalid');
  return facts;
}

export function isMarketplaceBackupFacts(value: unknown): value is MarketplaceBackupFacts {
  if (!value || typeof value !== 'object') return false;
  return ['members', 'presets', 'revisions', 'collections'].every((kind) => {
    const summary = (value as Record<string, unknown>)[kind];
    return Boolean(
      summary
      && typeof summary === 'object'
      && typeof (summary as Record<string, unknown>).count === 'number'
      && Number.isSafeInteger((summary as Record<string, unknown>).count)
      && typeof (summary as Record<string, unknown>).checksum === 'string',
    );
  });
}

export function assertMarketplaceBackupFactsMatch(
  expected: MarketplaceBackupFacts,
  actual: MarketplaceBackupFacts,
): void {
  for (const kind of ['members', 'presets', 'revisions', 'collections'] as const) {
    if (
      expected[kind].count !== actual[kind].count
      || expected[kind].checksum !== actual[kind].checksum
    ) {
      throw new Error(`Restored Marketplace ${kind} facts do not match the backup manifest`);
    }
  }
}
