import assert from 'node:assert/strict';
import test from 'node:test';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';
import { seedPublishedPreset } from '../server/marketplace/seed.ts';
import { seedDemoMarketplace } from '../server/marketplace/seedWorkflow.ts';
import type { MarketplaceSeedPool } from '../server/marketplace/seedWorkflow.ts';

test('clean-database seed creates the preset before its FK-backed tags and projection', async () => {
  let presetExists = false;
  let revisionExists = false;
  const writes: string[] = [];
  await seedPublishedPreset({
    async query(text) {
      if (text.includes('marketplace_published_preset_tags') && !presetExists) {
        throw new Error('tag preset FK missing');
      }
      if (text.includes('marketplace_published_preset_search_projection') && !presetExists) {
        throw new Error('projection preset FK missing');
      }
      if (text.includes('marketplace_published_preset_revisions') && !presetExists) {
        throw new Error('revision preset FK missing');
      }
      if (text.includes('INSERT INTO marketplace_published_presets')) presetExists = true;
      if (text.includes('INSERT INTO marketplace_published_preset_revisions')) revisionExists = true;
      writes.push(text.match(/INSERT INTO ([a-z_]+)/)?.[1] ?? 'unknown');
      return {};
    },
  }, demoPublishedPreset);

  assert.equal(presetExists, true);
  assert.equal(revisionExists, true);
  assert.deepEqual(writes.slice(-4), [
    'marketplace_published_presets',
    'marketplace_published_preset_revisions',
    'marketplace_published_preset_tags',
    'marketplace_published_preset_search_projection',
  ]);
});

test('production seed rebuilds exact resource dependency keys after its seed transaction', async () => {
  const queries: string[] = [];
  let releases = 0;
  const client = {
    async query(text: string) {
      queries.push(text.trim());
      return { rows: [] };
    },
    release() { releases += 1; },
  };
  await seedDemoMarketplace({
    async connect() { return client; },
  } as unknown as MarketplaceSeedPool, new Date('2026-08-29T08:00:00.000Z'));

  const seedCommit = queries.indexOf('COMMIT');
  const projectionRebuild = queries.findIndex((text, index) => (
    index > seedCommit
    && text.includes('marketplace_resource_dependency_keys(revision.resource_dependencies)')
  ));
  assert.ok(seedCommit >= 0);
  assert.ok(projectionRebuild > seedCommit);
  assert.equal(releases, 2);
});
