import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  evaluateMarketplaceBackupFreshness,
  assertCompleteMarketplaceBackup,
  readMarketplaceBackupManifest,
} from '../server/operations/backup.ts';

const backupDirectory = process.env.MARKETPLACE_BACKUP_DIR;
if (!backupDirectory) throw new Error('Set MARKETPLACE_BACKUP_DIR to durable encrypted storage');

const directory = resolve(backupDirectory);
const candidates = (await readdir(directory))
  .filter((name) => /^marketplace-\d{4}-\d{2}-\d{2}\.backup$/.test(name));
const completions: string[] = [];
for (const candidate of candidates) {
  try {
    const archiveName = `${candidate.slice(0, -'.backup'.length)}.dump`;
    const archivePath = resolve(directory, candidate, archiveName);
    const manifest = await readMarketplaceBackupManifest(`${archivePath}.json`);
    await assertCompleteMarketplaceBackup(archivePath, manifest);
    completions.push(manifest.completedAt);
  } catch {
    // An invalid manifest cannot prove a successful backup.
  }
}
completions.sort((left, right) => Date.parse(right) - Date.parse(left));
const latestCompletedAt = completions[0] ?? null;
const freshness = latestCompletedAt
  ? evaluateMarketplaceBackupFreshness(latestCompletedAt, new Date())
  : { fresh: false, ageHours: null, maxAgeHours: 23 };
const report = { passed: freshness.fresh, latestCompletedAt, ...freshness };
console.log(JSON.stringify(report));
if (!report.passed) process.exitCode = 1;
