import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import {
  readMarketplaceBackupFacts,
  runDailyMarketplaceBackup,
  marketplaceFileSha256,
} from '../server/operations/backup.ts';
import { marketplaceDatabaseIdentity } from '../server/operations/restoreSafety.ts';
import { postgresCommandEnvironment } from '../server/operations/postgresCommand.ts';

const connectionString = process.env.MARKETPLACE_BACKUP_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? process.env.POSTGRES_URL;
const backupDirectory = process.env.MARKETPLACE_BACKUP_DIR;
if (!connectionString) throw new Error('Set MARKETPLACE_BACKUP_DATABASE_URL, DATABASE_URL, or POSTGRES_URL');
if (!backupDirectory) throw new Error('Set MARKETPLACE_BACKUP_DIR to durable encrypted storage');

const startedAt = new Date();
const result = await runDailyMarketplaceBackup({
  directory: backupDirectory,
  now: startedAt,
  processId: process.pid,
}, async (paths) => {
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshotResult = await client.query<{ snapshot_id: string }>(
      'SELECT pg_export_snapshot() AS snapshot_id',
    );
    const facts = await readMarketplaceBackupFacts(client);
    await command('pg_dump', [
      '--format=custom', '--compress=9', '--no-owner', '--no-privileges',
      `--snapshot=${snapshotResult.rows[0].snapshot_id}`,
      `--file=${paths.partialArchivePath}`,
    ], postgresCommandEnvironment(connectionString));
    await client.query('COMMIT');
    const completedAt = new Date();
    const sha256 = await marketplaceFileSha256(paths.partialArchivePath);
    await writeFile(paths.partialManifestPath, `${JSON.stringify({
      formatVersion: 2,
      archive: basename(paths.archivePath),
      sha256,
      source: marketplaceDatabaseIdentity(connectionString),
      facts,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (cause) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
    throw cause;
  } finally {
    client.release();
    await pool.end();
  }
});
console.log(JSON.stringify({ status: result.status, ...result.paths }));

async function command(executable: string, args: string[], extraEnvironment: Record<string, string>) {
  await new Promise<void>((resolveCommand, reject) => {
    const child = spawn(executable, args, {
      stdio: 'inherit',
      env: { ...process.env, ...extraEnvironment },
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveCommand();
      else reject(new Error(`${executable} failed (${signal ?? code ?? 'unknown'})`));
    });
  });
}
