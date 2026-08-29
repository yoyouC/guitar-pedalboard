import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, link, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, resolve } from 'node:path';
import type { QueryResultRow } from 'pg';
import type { PostgresQueryable } from '../marketplace/postgresRepository.ts';
import {
  isMarketplaceDatabaseIdentity,
  type MarketplaceDatabaseIdentity,
} from './restoreSafety.ts';

const DEFAULT_LEASE_DURATION_MS = 2 * 60 * 60 * 1_000;
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
  archivePath: string;
  manifestPath: string;
  leasePath: string;
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

interface MarketplaceBackupLease {
  ownerToken: string;
  processId: number;
  hostname: string;
  acquiredAt: string;
  expiresAt: string;
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
  const archivePath = resolve(root, `marketplace-${dayKey}.dump`);
  const manifestPath = `${archivePath}.json`;
  return {
    dayKey,
    archivePath,
    manifestPath,
    leasePath: resolve(root, `marketplace-${dayKey}.lease`),
    partialArchivePath: resolve(root, `.marketplace-${dayKey}.${processId}.dump.partial`),
    partialManifestPath: resolve(root, `.marketplace-${dayKey}.${processId}.json.partial`),
  };
}

export async function runDailyMarketplaceBackup(
  input: {
    directory: string;
    now: Date;
    processId: number;
    leaseDurationMs?: number;
  },
  action: (paths: MarketplaceBackupArtifactPaths) => Promise<void>,
): Promise<{ status: 'completed' | 'skipped'; paths: MarketplaceBackupArtifactPaths }> {
  await mkdir(resolve(input.directory), { recursive: true });
  const paths = marketplaceBackupArtifactPaths(input.directory, input.now, input.processId);
  if (await isCompletedBackup(paths)) return { status: 'skipped', paths };
  const lease = await acquireLease(
    paths.leasePath,
    input.now,
    input.processId,
    input.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
  );
  try {
    if (await isCompletedBackup(paths)) return { status: 'skipped', paths };
    await Promise.all([rm(paths.archivePath, { force: true }), rm(paths.manifestPath, { force: true })]);
    try {
      await action(paths);
      const manifest = await readMarketplaceBackupManifest(paths.partialManifestPath);
      await assertCompleteMarketplaceBackup(
        paths.partialArchivePath, manifest, basename(paths.archivePath),
      );
      await assertLeaseOwner(paths.leasePath, lease.ownerToken);
      await publishWithoutOverwrite(paths.partialArchivePath, paths.archivePath);
      try {
        await publishWithoutOverwrite(paths.partialManifestPath, paths.manifestPath);
      } catch (cause) {
        await rm(paths.archivePath, { force: true });
        throw cause;
      }
      return { status: 'completed', paths };
    } finally {
      await Promise.all([
        rm(paths.partialArchivePath, { force: true }),
        rm(paths.partialManifestPath, { force: true }),
      ]);
    }
  } finally {
    await releaseLease(paths.leasePath, lease.ownerToken);
  }
}

async function acquireLease(
  leasePath: string,
  now: Date,
  processId: number,
  leaseDurationMs: number,
): Promise<MarketplaceBackupLease> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ownerToken = randomUUID();
    const candidatePath = `${leasePath}.candidate-${ownerToken}`;
    const lease: MarketplaceBackupLease = {
      ownerToken,
      processId,
      hostname: hostname(),
      acquiredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + leaseDurationMs).toISOString(),
    };
    try {
      const candidate = await open(candidatePath, 'wx', 0o600);
      try {
        await candidate.writeFile(`${JSON.stringify(lease)}\n`);
        await candidate.sync();
      } finally {
        await candidate.close();
      }
      await link(candidatePath, leasePath);
      await rm(candidatePath, { force: true });
      return lease;
    } catch (cause) {
      await rm(candidatePath, { force: true });
      if (!isAlreadyExists(cause)) throw cause;
      const existing = await readLease(leasePath);
      if (
        attempt === 0
        && leaseExpired(existing, now)
        && !leaseOwnerIsAlive(existing)
      ) {
        const stalePath = `${leasePath}.stale-${processId}-${now.getTime()}`;
        try {
          await rename(leasePath, stalePath);
          const moved = await readLease(stalePath);
          if (moved?.ownerToken !== existing?.ownerToken) {
            try { await link(stalePath, leasePath); } catch { /* another owner won */ }
            throw new Error('Marketplace backup lease changed during takeover');
          }
          await rm(stalePath, { force: true });
        } catch (renameCause) {
          if (!isNoEntry(renameCause)) throw renameCause;
        }
        continue;
      }
      throw new Error('Marketplace backup is already in progress');
    }
  }
  throw new Error('Marketplace backup is already in progress');
}

async function readLease(path: string): Promise<MarketplaceBackupLease | null> {
  try {
    const lease = JSON.parse(await readFile(path, 'utf8')) as Partial<MarketplaceBackupLease>;
    return typeof lease.ownerToken === 'string'
      && typeof lease.processId === 'number'
      && typeof lease.hostname === 'string'
      && typeof lease.acquiredAt === 'string'
      && typeof lease.expiresAt === 'string'
      ? lease as MarketplaceBackupLease
      : null;
  } catch {
    return null;
  }
}

function leaseExpired(lease: MarketplaceBackupLease | null, now: Date): boolean {
  return !lease || !Number.isFinite(Date.parse(lease.expiresAt))
    || Date.parse(lease.expiresAt) <= now.getTime();
}

function leaseOwnerIsAlive(lease: MarketplaceBackupLease | null): boolean {
  if (!lease || lease.hostname !== hostname()) return false;
  try {
    process.kill(lease.processId, 0);
    return true;
  } catch (cause) {
    return Boolean(cause && typeof cause === 'object' && 'code' in cause && cause.code === 'EPERM');
  }
}

async function assertLeaseOwner(leasePath: string, ownerToken: string): Promise<void> {
  if ((await readLease(leasePath))?.ownerToken !== ownerToken) {
    throw new Error('Marketplace backup lost its lease before publication');
  }
}

async function releaseLease(leasePath: string, ownerToken: string): Promise<void> {
  if ((await readLease(leasePath))?.ownerToken === ownerToken) {
    await rm(leasePath, { force: true });
  }
}

async function publishWithoutOverwrite(source: string, target: string): Promise<void> {
  try {
    await link(source, target);
  } catch (cause) {
    if (isAlreadyExists(cause)) throw new Error('Marketplace backup artifact was published by another owner');
    throw cause;
  }
}

function isAlreadyExists(cause: unknown): boolean {
  return Boolean(cause && typeof cause === 'object' && 'code' in cause && cause.code === 'EEXIST');
}

function isNoEntry(cause: unknown): boolean {
  return Boolean(cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT');
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
