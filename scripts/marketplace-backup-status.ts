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
const completions: Array<NonNullable<Awaited<ReturnType<typeof readCurrentMarketplaceBackup>>>> = [];
for (const dayKey of dayKeys) {
  const current = await readCurrentMarketplaceBackup(backupDirectory, dayKey);
  if (current) completions.push(current);
}
completions.sort((left, right) => (
  Date.parse(right.manifest.completedAt) - Date.parse(left.manifest.completedAt)
));
const latest = completions[0] ?? null;
const latestCompletedAt = latest?.manifest.completedAt ?? null;
const freshness = latestCompletedAt
  ? evaluateMarketplaceBackupFreshness(latestCompletedAt, new Date())
  : { fresh: false, ageHours: null, maxAgeHours: 23 };
const report = {
  passed: freshness.fresh,
  latestCompletedAt,
  latestArchivePath: latest?.paths.archivePath ?? null,
  latestManifestPath: latest?.paths.manifestPath ?? null,
  latestFencingToken: latest?.paths.fencingToken ?? null,
  ...freshness,
};
console.log(JSON.stringify(report));
if (!report.passed) process.exitCode = 1;
