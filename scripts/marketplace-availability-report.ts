import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  evaluateMarketplaceAvailability,
  type MarketplaceAvailabilityObservation,
} from '../server/operations/availability.ts';

const inputPath = process.env.MARKETPLACE_AVAILABILITY_INPUT;
const start = process.env.MARKETPLACE_AVAILABILITY_START;
const end = process.env.MARKETPLACE_AVAILABILITY_END;
if (!inputPath || !start || !end) {
  throw new Error('Set MARKETPLACE_AVAILABILITY_INPUT, MARKETPLACE_AVAILABILITY_START, and MARKETPLACE_AVAILABILITY_END');
}
const observations = (await readFile(resolve(inputPath), 'utf8'))
  .split('\n').filter(Boolean).map((line) => JSON.parse(line) as MarketplaceAvailabilityObservation);
const report = evaluateMarketplaceAvailability({ start: new Date(start), end: new Date(end), observations });
const json = `${JSON.stringify(report, null, 2)}\n`;
if (process.env.MARKETPLACE_AVAILABILITY_REPORT) {
  await writeFile(resolve(process.env.MARKETPLACE_AVAILABILITY_REPORT), json);
}
process.stdout.write(json);
if (!report.passed) process.exitCode = 1;
