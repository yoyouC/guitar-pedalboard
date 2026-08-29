import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const connectionString = process.env.MARKETPLACE_BACKUP_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? process.env.POSTGRES_URL;
const backupDirectory = process.env.MARKETPLACE_BACKUP_DIR;
if (!connectionString) throw new Error('Set MARKETPLACE_BACKUP_DATABASE_URL, DATABASE_URL, or POSTGRES_URL');
if (!backupDirectory) throw new Error('Set MARKETPLACE_BACKUP_DIR to durable encrypted storage');

const startedAt = new Date();
const stamp = startedAt.toISOString().replaceAll(':', '-');
const directory = resolve(backupDirectory);
await mkdir(directory, { recursive: true });
const archivePath = resolve(directory, `marketplace-${stamp}.dump`);
if (!archivePath.startsWith(`${directory}/`)) throw new Error('Backup path escaped its configured directory');

await command('pg_dump', [
  '--format=custom', '--compress=9', '--no-owner', '--no-privileges',
  `--file=${archivePath}`,
], { PGDATABASE: connectionString });
const completedAt = new Date();
const sha256 = await digest(archivePath);
const manifestPath = `${archivePath}.json`;
await writeFile(manifestPath, `${JSON.stringify({
  formatVersion: 1,
  archive: archivePath.split('/').at(-1),
  sha256,
  startedAt: startedAt.toISOString(),
  completedAt: completedAt.toISOString(),
  durationMs: completedAt.getTime() - startedAt.getTime(),
}, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
console.log(JSON.stringify({ archivePath, manifestPath, sha256 }));

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
