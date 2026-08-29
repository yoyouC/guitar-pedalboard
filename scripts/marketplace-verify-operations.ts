import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';
import {
  createPostgresPublishedPresetPublicationRepository,
  createPostgresPublishedPresetRepository,
} from '../server/marketplace/postgresRepository.ts';
import { evaluateMarketplaceOperationalReport } from '../server/operations/verification.ts';
import { createPostgresPublishedPresetSearchRepository } from '../server/search/postgresRepository.ts';
import type { PublishedPresetSearchInput } from '../server/search/repository.ts';

const connectionString = process.env.MARKETPLACE_BENCHMARK_DATABASE_URL;
if (!connectionString) throw new Error('Set MARKETPLACE_BENCHMARK_DATABASE_URL');
const samples = Number(process.env.MARKETPLACE_BENCHMARK_SAMPLES ?? 30);
if (!Number.isInteger(samples) || samples < 20) throw new Error('Use at least 20 benchmark samples');

const pool = new Pool({ connectionString, max: 4 });
const search = createPostgresPublishedPresetSearchRepository(pool);
const detail = createPostgresPublishedPresetRepository(pool);
const publication = createPostgresPublishedPresetPublicationRepository(pool);
const searchInput = (text: string): PublishedPresetSearchInput => ({
  text, tagIds: [], pedalIds: [], ampIds: [], cabIds: [], resourceKinds: [],
  resourceDependencyKeys: [], publishedAfter: null, publishedBefore: null, limit: 20, cursor: null,
});
const durationsMs = { list: [] as number[], detail: [] as number[], search: [] as number[], revision: [] as number[] };
const time = async (operation: keyof typeof durationsMs, action: () => Promise<unknown>) => {
  const started = performance.now();
  await action();
  durationsMs[operation].push(performance.now() - started);
};
const observeSearchConvergence = async (marker: string, presetId: string) => {
  const started = performance.now();
  while (performance.now() - started <= 60_000) {
    const result = await search.searchPublicPresets(searchInput(marker));
    if (result.items.some((item) => item.id === presetId)) {
      return { observed: true, elapsedMs: performance.now() - started };
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  return { observed: false, elapsedMs: performance.now() - started };
};

try {
  const counts = await pool.query<{ members: string; presets: string }>(
    `SELECT (SELECT count(*) FROM marketplace_members)::text AS members,
            (SELECT count(*) FROM marketplace_published_presets WHERE visibility = 'public')::text AS presets`,
  );
  const dataset = { members: Number(counts.rows[0].members), publicPresets: Number(counts.rows[0].presets) };
  await search.searchPublicPresets(searchInput(''));
  await detail.findVisibleById('preset-bench-1');
  await search.searchPublicPresets(searchInput('rare quasar'));

  let managed = await publication.findManagedById('preset-bench-100000', 'member-bench-10000');
  for (let index = 0; index < samples; index += 1) {
    await time('list', () => search.searchPublicPresets(searchInput('')));
    await time('detail', () => detail.findVisibleById('preset-bench-1'));
    await time('search', () => search.searchPublicPresets(searchInput('rare quasar')));
    await time('revision', async () => {
      managed = await publication.appendRevision({
        presetId: managed.id,
        creatorId: managed.creator.id,
        revisionId: `revision-benchmark-${randomUUID()}`,
        expectedUpdatedAt: new Date(managed.updatedAt),
        now: new Date(),
        schemaVersion: demoPublishedPreset.currentRevision.schemaVersion,
        rig: demoPublishedPreset.currentRevision.rig,
        resourceDependencies: demoPublishedPreset.currentRevision.resourceDependencies,
        derivedAttributes: demoPublishedPreset.derivedAttributes,
      });
    });
  }

  const publicationMarker = `publication-${randomUUID()}`;
  const publicationId = `preset-${randomUUID()}`;
  const publicationStarted = performance.now();
  await publication.create({
    id: publicationId,
    revisionId: `revision-${randomUUID()}`,
    creator: {
      id: 'member-bench-10000',
      handle: 'bench-10000',
      displayName: 'Benchmark Member 10000',
    },
    title: publicationMarker,
    description: 'Search convergence publication probe',
    tagIds: ['tone-crunch'],
    schemaVersion: demoPublishedPreset.currentRevision.schemaVersion,
    rig: demoPublishedPreset.currentRevision.rig,
    resourceDependencies: demoPublishedPreset.currentRevision.resourceDependencies,
    derivedAttributes: demoPublishedPreset.derivedAttributes,
    now: new Date(),
  });
  const publicationConvergence = await observeSearchConvergence(publicationMarker, publicationId);
  publicationConvergence.elapsedMs += performance.now() - publicationStarted
    - publicationConvergence.elapsedMs;

  const metadataMarker = `metadata-${randomUUID()}`;
  const metadataStarted = performance.now();
  managed = await publication.updateMetadata({
    presetId: managed.id,
    creatorId: managed.creator.id,
    expectedUpdatedAt: new Date(managed.updatedAt),
    now: new Date(),
    title: metadataMarker,
    description: managed.description,
    tagIds: managed.tags.map((tag) => tag.id),
  });
  const metadataConvergence = await observeSearchConvergence(metadataMarker, managed.id);
  metadataConvergence.elapsedMs += performance.now() - metadataStarted - metadataConvergence.elapsedMs;
  const searchConvergenceMs = {
    publication: publicationConvergence.elapsedMs,
    metadata: metadataConvergence.elapsedMs,
  };
  const report = evaluateMarketplaceOperationalReport({ dataset, durationsMs, searchConvergenceMs });
  const convergenceObserved = {
    publication: publicationConvergence.observed,
    metadata: metadataConvergence.observed,
  };
  const output = { ...report, convergenceObserved, measuredAt: new Date().toISOString() };
  for (const mutation of ['publication', 'metadata'] as const) {
    if (!convergenceObserved[mutation]) {
      output.failures.push({ metric: `search.${mutation}.convergence.observed`, actual: 0, target: 1 });
    }
  }
  output.passed = output.failures.length === 0;
  const json = `${JSON.stringify(output, null, 2)}\n`;
  if (process.env.MARKETPLACE_BENCHMARK_REPORT) {
    await writeFile(resolve(process.env.MARKETPLACE_BENCHMARK_REPORT), json);
  }
  process.stdout.write(json);
  if (!output.passed) process.exitCode = 1;
} finally {
  await pool.end();
}
