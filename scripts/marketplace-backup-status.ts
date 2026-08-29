import { readdir } from 'node:fs/promises';
import {
  evaluateMarketplaceBackupFreshness,
  readCurrentMarketplaceBackup,
} from '../server/operations/backup.ts';

const backupDirectory = process.env.MARKETPLACE_BACKUP_DIR;
if (!backupDirectory) throw new Error('Set MARKETPLACE_BACKUP_DIR to durable encrypted storage');

const candidates = await readdir(backupDirectory);
const dayKeys = new Set<string>();
for (const candidate of candidates) {
  const match = /^marketplace-(\d{4}-\d{2}-\d{2})(?:\.backup|\.fence-\d+\.claim)$/.exec(candidate);
  if (match) dayKeys.add(match[1]);
}
const completions: string[] = [];
for (const dayKey of dayKeys) {
  const current = await readCurrentMarketplaceBackup(backupDirectory, dayKey);
  if (current) completions.push(current.manifest.completedAt);
}
completions.sort((left, right) => Date.parse(right) - Date.parse(left));
const latestCompletedAt = completions[0] ?? null;
const freshness = latestCompletedAt
  ? evaluateMarketplaceBackupFreshness(latestCompletedAt, new Date())
  : { fresh: false, ageHours: null, maxAgeHours: 23 };
const report = { passed: freshness.fresh, latestCompletedAt, ...freshness };
console.log(JSON.stringify(report));
if (!report.passed) process.exitCode = 1;
