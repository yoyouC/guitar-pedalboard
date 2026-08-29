import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { assertDisposableRestoreDatabase } from '../server/operations/restoreSafety.ts';

const restoreConnectionString = process.env.MARKETPLACE_RESTORE_DATABASE_URL;
const archivePath = process.env.MARKETPLACE_RESTORE_DRILL_ARCHIVE;
const manifestPath = process.env.MARKETPLACE_RESTORE_DRILL_MANIFEST;
if (process.env.MARKETPLACE_ALLOW_RESTORE_DRILL !== 'true') {
  throw new Error('Set MARKETPLACE_ALLOW_RESTORE_DRILL=true for this destructive disposable-target drill');
}
if (!restoreConnectionString || !archivePath || !manifestPath) {
  throw new Error('Set restore database, archive, and manifest variables');
}
assertDisposableRestoreDatabase(
  restoreConnectionString,
  process.env.DATABASE_URL ?? process.env.POSTGRES_URL,
);

const archive = resolve(archivePath);
const manifest = JSON.parse(await readFile(resolve(manifestPath), 'utf8')) as {
  formatVersion?: unknown; sha256?: unknown; completedAt?: unknown;
};
if (
  manifest.formatVersion !== 1
  || typeof manifest.sha256 !== 'string'
  || typeof manifest.completedAt !== 'string'
) throw new Error('Backup manifest is invalid');
const actualDigest = await digest(archive);
if (actualDigest !== manifest.sha256) throw new Error('Backup archive checksum does not match its manifest');

const startedAt = new Date();
await command('pg_restore', [
  '--clean', '--if-exists', '--no-owner', '--no-privileges', '--single-transaction', archive,
], { PGDATABASE: restoreConnectionString });
const pool = new Pool({ connectionString: restoreConnectionString });
let facts: Record<string, number>;
try {
  const result = await pool.query<{
    members: string; presets: string; revisions: string; collections: string;
  }>(`SELECT
      (SELECT count(*) FROM marketplace_members)::text AS members,
      (SELECT count(*) FROM marketplace_published_presets)::text AS presets,
      (SELECT count(*) FROM marketplace_published_preset_revisions)::text AS revisions,
      (SELECT count(*) FROM marketplace_preset_collections)::text AS collections`);
  const row = result.rows[0];
  facts = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
  if (facts.revisions < facts.presets) throw new Error('Restored facts violate preset/revision cardinality');
  const invalidCurrent = await pool.query(
    `SELECT 1 FROM marketplace_published_presets AS preset
     LEFT JOIN marketplace_published_preset_revisions AS revision
       ON revision.preset_id = preset.id AND revision.id = preset.current_revision_id
     WHERE revision.id IS NULL LIMIT 1`,
  );
  if (invalidCurrent.rowCount) throw new Error('Restored preset has no current immutable revision');
} finally {
  await pool.end();
}
const completedAt = new Date();
const durationMs = completedAt.getTime() - startedAt.getTime();
const backupAgeMs = startedAt.getTime() - Date.parse(manifest.completedAt);
const report = {
  passed: durationMs <= 8 * 60 * 60 * 1000 && backupAgeMs <= 24 * 60 * 60 * 1000,
  archiveSha256: actualDigest,
  backupCompletedAt: manifest.completedAt,
  drillStartedAt: startedAt.toISOString(),
  drillCompletedAt: completedAt.toISOString(),
  rpoHours: backupAgeMs / 3_600_000,
  rtoHours: durationMs / 3_600_000,
  targets: { rpoHours: 24, rtoHours: 8 },
  facts,
};
if (process.env.MARKETPLACE_RESTORE_DRILL_REPORT) {
  await writeFile(resolve(process.env.MARKETPLACE_RESTORE_DRILL_REPORT), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report));
if (!report.passed) process.exitCode = 1;

async function command(executable: string, args: string[], extraEnvironment: Record<string, string>) {
  await new Promise<void>((resolveCommand, reject) => {
    const child = spawn(executable, args, {
      stdio: 'inherit', env: { ...process.env, ...extraEnvironment },
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveCommand();
      else reject(new Error(`${executable} failed (${signal ?? code ?? 'unknown'})`));
    });
  });
}

async function digest(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolveDigest, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolveDigest);
  });
  return hash.digest('hex');
}
