import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import {
  assertCurrentMarketplaceBackupSelection,
  assertMarketplaceBackupFactsMatch,
  readMarketplaceBackupFacts,
  type MarketplaceBackupFacts,
} from '../server/operations/backup.ts';
import {
  assertDisposableRestoreDatabase,
  assertExpectedMarketplaceBackupSource,
} from '../server/operations/restoreSafety.ts';
import { postgresCommandEnvironment } from '../server/operations/postgresCommand.ts';

const restoreConnectionString = process.env.MARKETPLACE_RESTORE_DATABASE_URL;
const expectedSourceConnectionString = process.env.MARKETPLACE_EXPECTED_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? process.env.POSTGRES_URL;
const archivePath = process.env.MARKETPLACE_RESTORE_DRILL_ARCHIVE;
const manifestPath = process.env.MARKETPLACE_RESTORE_DRILL_MANIFEST;
const backupDirectory = process.env.MARKETPLACE_BACKUP_DIR;
if (process.env.MARKETPLACE_ALLOW_RESTORE_DRILL !== 'true') {
  throw new Error('Set MARKETPLACE_ALLOW_RESTORE_DRILL=true for this destructive disposable-target drill');
}
if (
  !restoreConnectionString || !archivePath || !manifestPath
  || !expectedSourceConnectionString || !backupDirectory
) {
  throw new Error(
    'Set backup directory, restore database, expected source database, archive, and manifest variables',
  );
}
assertDisposableRestoreDatabase(
  restoreConnectionString,
  expectedSourceConnectionString,
);

const selected = await assertCurrentMarketplaceBackupSelection(
  resolve(backupDirectory), resolve(archivePath), resolve(manifestPath),
);
const archive = selected.paths.archivePath;
const manifest = selected.manifest;
assertExpectedMarketplaceBackupSource(expectedSourceConnectionString, manifest.source);
const actualDigest = manifest.sha256;

const startedAt = new Date();
const restoreEnvironment = postgresCommandEnvironment(restoreConnectionString);
await command('pg_restore', [
  '--clean', '--if-exists', '--no-owner', '--no-privileges', '--single-transaction',
  `--dbname=${restoreEnvironment.PGDATABASE}`,
  archive,
], restoreEnvironment);
const pool = new Pool({ connectionString: restoreConnectionString });
let facts: MarketplaceBackupFacts;
try {
  facts = await readMarketplaceBackupFacts(pool);
  assertMarketplaceBackupFactsMatch(manifest.facts, facts);
  if (facts.revisions.count < facts.presets.count) {
    throw new Error('Restored facts violate preset/revision cardinality');
  }
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
  source: manifest.source,
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
