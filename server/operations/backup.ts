import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { QueryResultRow } from 'pg';
import type { PostgresQueryable } from '../marketplace/postgresRepository.js';
import {
  isMarketplaceDatabaseIdentity,
  type MarketplaceDatabaseIdentity,
} from './restoreSafety.js';

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
  fencingToken: string | null;
  fencePath: string | null;
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
  release(): Promise<void>;
}

export interface MarketplaceBackupMutex {
  tryAcquire(dayKey: string): Promise<MarketplaceBackupMutexLease | null>;
}

export interface MarketplaceBackupReadObserver {
  candidateSelected(paths: MarketplaceBackupArtifactPaths): Promise<void>;
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

      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          let destroy = false;
          try {
            const unlocked = await client.query<{ unlocked: boolean }>(
              `SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked`,
              [key],
            );
            if (!unlocked.rows[0]?.unlocked) {
              throw new Error('Marketplace backup publication mutex was not held');
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
  fencingToken: string | null = null,
): MarketplaceBackupArtifactPaths {
  const dayKey = now.toISOString().slice(0, 10);
  return marketplaceBackupArtifactPathsForDay(
    directory, dayKey, processId, fencingToken,
  );
}

function marketplaceBackupArtifactPathsForDay(
  directory: string,
  dayKey: string,
  processId: number,
  fencingToken: string | null,
): MarketplaceBackupArtifactPaths {
  const root = resolve(directory);
  const artifactStem = fencingToken
    ? `marketplace-${dayKey}.fence-${fencingToken}`
    : `marketplace-${dayKey}`;
  const bundlePath = resolve(root, `${artifactStem}.backup`);
  const partialBundlePath = resolve(
    root,
    `.${artifactStem}.${processId}.backup.partial`,
  );
  const archiveName = `marketplace-${dayKey}.dump`;
  const archivePath = resolve(bundlePath, archiveName);
  const manifestPath = `${archivePath}.json`;
  return {
    dayKey,
    fencingToken,
    fencePath: fencingToken ? resolve(root, `${artifactStem}.claim`) : null,
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
  const dayKey = input.now.toISOString().slice(0, 10);
  const completed = await readCurrentMarketplaceBackup(input.directory, dayKey);
  if (completed) return { status: 'skipped', paths: completed.paths };
  const lease = await input.mutex.tryAcquire(dayKey);
  if (!lease) throw new Error('Marketplace backup is already in progress');
  try {
    const completedAfterLock = await readCurrentMarketplaceBackup(input.directory, dayKey);
    if (completedAfterLock) return { status: 'skipped', paths: completedAfterLock.paths };
    const fencingToken = await claimNextMarketplaceBackupFence(input.directory, dayKey);
    const paths = marketplaceBackupArtifactPaths(
      input.directory, input.now, input.processId, fencingToken,
    );
    await rm(paths.partialBundlePath, { recursive: true, force: true });
    await mkdir(paths.partialBundlePath, { recursive: false, mode: 0o700 });
    try {
      await action(paths);
      const manifest = await readMarketplaceBackupManifest(paths.partialManifestPath);
      await assertCompleteMarketplaceBackup(
        paths.partialArchivePath, manifest, basename(paths.archivePath),
      );
      await rename(paths.partialBundlePath, paths.bundlePath);
      return { status: 'completed', paths };
    } finally {
      await rm(paths.partialBundlePath, { recursive: true, force: true });
    }
  } finally {
    await releaseLease(lease);
  }
}

export async function readCurrentMarketplaceBackup(
  directory: string,
  dayKey: string,
  observer?: MarketplaceBackupReadObserver,
): Promise<{ paths: MarketplaceBackupArtifactPaths; manifest: MarketplaceBackupManifest } | null> {
  for (;;) {
    const fencingToken = await highestMarketplaceBackupFence(directory, dayKey);
    const paths = marketplaceBackupArtifactPathsForDay(directory, dayKey, 0, fencingToken);
    await observer?.candidateSelected(paths);
    let candidate: { paths: MarketplaceBackupArtifactPaths; manifest: MarketplaceBackupManifest }
      | null = null;
    try {
      const manifest = await readMarketplaceBackupManifest(paths.manifestPath);
      await assertCompleteMarketplaceBackup(
        paths.archivePath, manifest, basename(paths.archivePath),
      );
      candidate = { paths, manifest };
    } catch {
      // A failed highest claim remains current only if no newer claim appeared.
    }
    if (await highestMarketplaceBackupFence(directory, dayKey) === fencingToken) {
      return candidate;
    }
  }
}

export async function assertCurrentMarketplaceBackupSelection(
  directory: string,
  archivePath: string,
  manifestPath: string,
): Promise<{ paths: MarketplaceBackupArtifactPaths; manifest: MarketplaceBackupManifest }> {
  const requestedManifest = await readMarketplaceBackupManifest(resolve(manifestPath));
  const dayKey = requestedManifest.startedAt.slice(0, 10);
  const current = await readCurrentMarketplaceBackup(directory, dayKey);
  if (
    !current
    || current.paths.archivePath !== resolve(archivePath)
    || current.paths.manifestPath !== resolve(manifestPath)
  ) {
    throw new Error('Marketplace backup is not the current fencing claim');
  }
  return current;
}

async function claimNextMarketplaceBackupFence(
  directory: string,
  dayKey: string,
): Promise<string> {
  const root = resolve(directory);
  for (;;) {
    const highest = await highestMarketplaceBackupFence(directory, dayKey);
    const next = highest === null ? 1n : BigInt(highest) + 1n;
    const token = next.toString();
    const claimPath = marketplaceBackupArtifactPathsForDay(root, dayKey, 0, token).fencePath;
    if (!claimPath) throw new Error('Marketplace backup fencing claim path is unavailable');
    try {
      const claim = await open(claimPath, 'wx', 0o600);
      try {
        await claim.sync();
      } finally {
        await claim.close();
      }
      return token;
    } catch (cause) {
      if (!isAlreadyExists(cause)) throw cause;
    }
  }
}

async function highestMarketplaceBackupFence(
  directory: string,
  dayKey: string,
): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(resolve(directory));
  } catch (cause) {
    if (isNoEntry(cause)) return null;
    throw cause;
  }
  const escapedDayKey = dayKey.replaceAll('-', '\\-');
  const pattern = new RegExp(`^marketplace-${escapedDayKey}\\.fence-(\\d+)\\.claim$`);
  let highest: bigint | null = null;
  for (const name of names) {
    const match = pattern.exec(name);
    if (!match) continue;
    const token = BigInt(match[1]);
    if (highest === null || token > highest) highest = token;
  }
  return highest?.toString() ?? null;
}

async function releaseLease(
  lease: MarketplaceBackupMutexLease,
): Promise<void> {
  await lease.release();
}

function isAlreadyExists(cause: unknown): boolean {
  return Boolean(cause && typeof cause === 'object' && 'code' in cause && cause.code === 'EEXIST');
}

function isNoEntry(cause: unknown): boolean {
  return Boolean(cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT');
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
