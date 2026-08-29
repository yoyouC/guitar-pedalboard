import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Client, type Pool } from 'pg';
import {
  createPostgresPresetCollectionManagementRepository,
} from '../server/collections/postgresRepository.ts';
import { PresetCollectionConflictError } from '../server/collections/repository.ts';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';
import { seedPublishedPreset } from '../server/marketplace/seed.ts';
import type { CanonicalPublishedPreset } from '../shared/marketplace.ts';

const connectionString = process.env.MARKETPLACE_TEST_DATABASE_URL;

test('PostgreSQL collections atomically preserve order, revisions, placeholders, and conflicts', {
  skip: connectionString ? false : 'Set MARKETPLACE_TEST_DATABASE_URL for PostgreSQL collection integration',
}, async () => {
  const client = new Client({ connectionString });
  const schema = `marketplace_collection_${process.pid}_${Date.now()}`;
  await client.connect();
  const poolLike = {
    query: client.query.bind(client),
    async connect() {
      return { query: client.query.bind(client), release() {} };
    },
  } as unknown as Pool;
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    for (let index = 1; index <= 7; index += 1) {
      const name = [
        '0001_published_presets.sql',
        '0002_authentication.sql',
        '0003_member_profiles.sql',
        '0004_preset_publication.sql',
        '0005_preset_revision_management.sql',
        '0006_preset_remix_provenance.sql',
        '0007_preset_collections.sql',
      ][index - 1];
      await client.query(await readFile(
        new URL(`../server/marketplace/migrations/${name}`, import.meta.url),
        'utf8',
      ));
    }
    const ownPreset: CanonicalPublishedPreset = {
      ...structuredClone(demoPublishedPreset),
      id: 'preset-ada-private',
      title: 'Ada Private',
      visibility: 'unlisted',
      creator: { id: 'member-ada', handle: 'ada', displayName: 'Ada' },
      currentRevision: {
        ...structuredClone(demoPublishedPreset.currentRevision),
        id: 'revision-ada-private-1',
      },
    };
    await client.query('BEGIN');
    await seedPublishedPreset(client, demoPublishedPreset);
    await seedPublishedPreset(client, ownPreset);
    await client.query('COMMIT');

    const repository = createPostgresPresetCollectionManagementRepository(poolLike);
    const created = await repository.create({
      id: 'collection-ada-live',
      creator: ownPreset.creator,
      title: 'Live Set',
      description: 'Pinned tones.',
      tagIds: ['genre-rock'],
      visibility: 'unlisted',
      now: new Date('2026-08-29T10:00:00.000Z'),
    });
    const updated = await repository.update({
      collectionId: created.id,
      creatorId: ownPreset.creator.id,
      title: created.title,
      description: created.description,
      tagIds: ['genre-rock'],
      visibility: 'unlisted',
      items: [
        { presetId: ownPreset.id, revisionId: ownPreset.currentRevision.id },
        { presetId: demoPublishedPreset.id, revisionId: demoPublishedPreset.currentRevision.id },
      ],
      expectedUpdatedAt: new Date(created.updatedAt),
      now: new Date('2026-08-29T11:00:00.000Z'),
    });
    assert.deepEqual(updated.items.map((item) => item.position), [0, 1]);
    assert.deepEqual(updated.items.map((item) => item.revisionId), [
      ownPreset.currentRevision.id,
      demoPublishedPreset.currentRevision.id,
    ]);
    assert.equal(updated.items[1].creator.id, demoPublishedPreset.creator.id);

    await client.query('BEGIN');
    await client.query(
      `INSERT INTO marketplace_published_preset_revisions
         (id, preset_id, schema_version, resource_dependencies, derived_attributes, rig, created_at)
       SELECT 'revision-demo-new', preset_id, schema_version, resource_dependencies,
              derived_attributes, rig, now()
       FROM marketplace_published_preset_revisions WHERE id = $1`,
      [demoPublishedPreset.currentRevision.id],
    );
    await client.query(
      `UPDATE marketplace_published_presets
       SET current_revision_id = 'revision-demo-new', updated_at = now()
       WHERE id = $1`,
      [demoPublishedPreset.id],
    );
    await client.query('COMMIT');
    const stillPinned = await repository.findVisibleById(created.id);
    assert.equal(stillPinned?.items[1].revisionId, demoPublishedPreset.currentRevision.id);

    await client.query(
      `UPDATE marketplace_published_presets SET visibility = 'withdrawn' WHERE id = $1`,
      [demoPublishedPreset.id],
    );
    const placeholder = await repository.findVisibleById(created.id);
    assert.deepEqual(placeholder?.items[1], {
      position: 1,
      presetId: demoPublishedPreset.id,
      revisionId: demoPublishedPreset.currentRevision.id,
      availability: 'unavailable',
      title: null,
      creator: demoPublishedPreset.creator,
    });

    await assert.rejects(() => repository.update({
      collectionId: created.id,
      creatorId: ownPreset.creator.id,
      title: 'Stale overwrite',
      description: '',
      tagIds: ['genre-rock'],
      visibility: 'unlisted',
      items: [],
      expectedUpdatedAt: new Date(created.updatedAt),
      now: new Date('2026-08-29T12:00:00.000Z'),
    }), PresetCollectionConflictError);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
});
