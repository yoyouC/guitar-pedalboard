import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Client, type Pool } from 'pg';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';
import { createPostgresPublishedPresetPublicationRepository } from '../server/marketplace/postgresRepository.ts';
import { seedPublishedPreset } from '../server/marketplace/seed.ts';
import {
  createPostgresPublishedPresetSearchRepository,
  rebuildPublishedPresetSearchProjection,
} from '../server/search/postgresRepository.ts';
import type { PublishedPresetSearchInput } from '../server/search/repository.ts';
import type { CanonicalPublishedPreset } from '../shared/marketplace.ts';

const connectionString = process.env.MARKETPLACE_TEST_DATABASE_URL;

function searchInput(overrides: Partial<PublishedPresetSearchInput> = {}): PublishedPresetSearchInput {
  return {
    text: '',
    tagIds: [],
    pedalIds: [],
    ampIds: [],
    cabIds: [],
    resourceKinds: [],
    resourceDependencyKeys: [],
    publishedAfter: null,
    publishedBefore: null,
    limit: 20,
    cursor: null,
    ...overrides,
  };
}

function clonePreset(
  id: string,
  title: string,
  visibility: CanonicalPublishedPreset['visibility'],
  createdAt: string,
): CanonicalPublishedPreset {
  return {
    ...structuredClone(demoPublishedPreset),
    id,
    title,
    visibility,
    currentRevision: {
      ...structuredClone(demoPublishedPreset.currentRevision),
      id: `revision-${id}`,
    },
    createdAt,
    updatedAt: createdAt,
  };
}

test('PostgreSQL search uses live public facts, stable cursors, and a rebuildable Rig projection', {
  skip: connectionString ? false : 'Set MARKETPLACE_TEST_DATABASE_URL for PostgreSQL search integration',
}, async () => {
  const client = new Client({ connectionString });
  const schema = `marketplace_search_${process.pid}_${Date.now()}`;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    const migrations = [
      '0001_published_presets.sql',
      '0002_authentication.sql',
      '0003_member_profiles.sql',
      '0004_preset_publication.sql',
      '0005_preset_revision_management.sql',
      '0006_preset_remix_provenance.sql',
      '0007_preset_collections.sql',
      '0008_preset_search_indexes.sql',
      '0015_marketplace_text_search.sql',
    ];
    for (const migration of migrations) {
      await client.query(await readFile(
        new URL(`../server/marketplace/migrations/${migration}`, import.meta.url),
        'utf8',
      ));
    }
    const poolLike = {
      query: client.query.bind(client),
      async connect() {
        return { query: client.query.bind(client), release() {} };
      },
    } as unknown as Pool;
    const newest = clonePreset(
      'preset-search-newest', 'Café Crunch', 'public', '2026-08-29T03:00:00.000Z',
    );
    const older = clonePreset(
      'preset-search-older', 'Rock Rhythm', 'public', '2026-08-29T03:00:00.000Z',
    );
    const unlisted = clonePreset(
      'preset-search-secret', 'Secret Distortion', 'unlisted', '2026-08-29T04:00:00.000Z',
    );
    const withdrawn = clonePreset(
      'preset-search-withdrawn', 'Withdrawn-only Distortion', 'withdrawn', '2026-08-29T04:00:00.000Z',
    );
    const hidden = clonePreset(
      'preset-search-hidden', 'Hidden-only Distortion', 'hidden', '2026-08-29T04:00:00.000Z',
    );
    const toneDependency = clonePreset(
      'preset-search-resource', 'Exact Resource', 'public', '2026-08-29T01:00:00.000Z',
    );
    toneDependency.tags = [{
      id: 'tone-clean', dimension: 'tone', nameZh: '清音', nameEn: 'Clean',
    }];
    toneDependency.currentRevision.resourceDependencies = [
      { kind: 'builtin' },
      { kind: 'tone3000', toneId: '123', modelId: '456' },
    ];
    toneDependency.derivedAttributes.resourceKinds = ['builtin', 'tone3000'];
    toneDependency.currentRevision.derivedAttributes.resourceKinds = ['builtin', 'tone3000'];
    await client.query('BEGIN');
    for (const preset of [newest, older, unlisted, withdrawn, hidden, toneDependency]) {
      await seedPublishedPreset(client, preset);
    }
    await client.query('COMMIT');
    await rebuildPublishedPresetSearchProjection(poolLike, new Date('2026-08-29T04:30:00.000Z'));
    await client.query(
      `UPDATE marketplace_tags SET aliases = '["distortion", "rock tone"]'::jsonb
       WHERE id = 'tone-crunch'`,
    );

    const repository = createPostgresPublishedPresetSearchRepository(client);
    const alias = await repository.searchPublicPresets(searchInput({
      text: 'distorsion',
      ampIds: [newest.derivedAttributes.ampId],
      cabIds: [newest.derivedAttributes.cabId],
      resourceKinds: ['builtin'],
    }));
    assert.deepEqual(alias.items.map((item) => item.id), [older.id, newest.id]);
    assert.equal(JSON.stringify(alias).includes(unlisted.id), false);
    assert.deepEqual(
      (await repository.searchPublicPresets(searchInput({
        resourceDependencyKeys: ['tone3000:123:456'],
      }))).items.map((item) => item.id),
      [toneDependency.id],
    );
    for (const text of ['withdrawn-only', 'hidden-only']) {
      assert.deepEqual((await repository.searchPublicPresets(searchInput({ text }))).items, []);
    }

    const first = await repository.searchPublicPresets(searchInput({ text: 'r', limit: 1 }));
    assert.deepEqual(first.items.map((item) => item.id), [older.id]);
    assert.equal(typeof first.nextCursor, 'string');
    const second = await repository.searchPublicPresets(searchInput({
      text: 'r', limit: 1, cursor: first.nextCursor,
    }));
    assert.deepEqual(second.items.map((item) => item.id), [newest.id]);

    await createPostgresPublishedPresetPublicationRepository(poolLike).create({
      id: 'preset-fresh-publication',
      revisionId: 'revision-fresh-publication-1',
      creator: demoPublishedPreset.creator,
      title: 'Freshly Published',
      description: '',
      tagIds: ['tone-crunch'],
      schemaVersion: demoPublishedPreset.currentRevision.schemaVersion,
      rig: demoPublishedPreset.currentRevision.rig,
      resourceDependencies: demoPublishedPreset.currentRevision.resourceDependencies,
      derivedAttributes: demoPublishedPreset.derivedAttributes,
      now: new Date('2026-08-29T03:30:00.000Z'),
    });
    assert.deepEqual(
      (await repository.searchPublicPresets(searchInput({ text: 'freshly' }))).items.map((item) => item.id),
      ['preset-fresh-publication'],
    );

    await client.query(
      `UPDATE marketplace_published_presets SET title = 'Immediate Search' WHERE id = $1`,
      [newest.id],
    );
    const immediate = await repository.searchPublicPresets(searchInput({ text: 'immed' }));
    assert.deepEqual(immediate.items.map((item) => item.id), [newest.id]);

    await client.query(
      `DELETE FROM marketplace_published_preset_search_projection WHERE preset_id = $1`,
      [newest.id],
    );
    assert.deepEqual((await repository.searchPublicPresets(searchInput({ text: 'immed' }))).items, []);
    await rebuildPublishedPresetSearchProjection(poolLike, new Date('2026-08-29T05:00:00.000Z'));
    assert.deepEqual(
      (await repository.searchPublicPresets(searchInput({ text: 'immed' }))).items.map((item) => item.id),
      [newest.id],
    );
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
});
