import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { createPostgresPublishedPresetPublicationRepository } from '../server/marketplace/postgresRepository.ts';
import {
  PublishedPresetConflictError,
  PublishedPresetSourceError,
} from '../server/marketplace/repository.ts';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';

test('PostgreSQL publication rolls back when the derived search projection fails', async () => {
  const statements: string[] = [];
  const client = {
    async query(text: string) {
      statements.push(text.trim().split(/\s+/).slice(0, 4).join(' '));
      if (text.includes('SELECT id, dimension')) {
        return {
          rows: [{
            id: 'tone-crunch',
            dimension: 'tone',
            name_zh: 'Crunch',
            name_en: 'Crunch',
          }],
        };
      }
      if (text.includes('marketplace_published_preset_search_projection')) {
        throw new Error('projection write failed');
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = { async connect() { return client; } } as unknown as Pool;
  const repository = createPostgresPublishedPresetPublicationRepository(pool);

  await assert.rejects(() => repository.create({
    id: 'preset-ada-crunch',
    revisionId: 'revision-ada-crunch-1',
    creator: { id: 'member-ada', handle: 'ada', displayName: 'Ada' },
    title: 'Ada Crunch',
    description: '',
    tagIds: ['tone-crunch'],
    schemaVersion: 5,
    rig: demoPublishedPreset.currentRevision.rig,
    resourceDependencies: [{ kind: 'builtin' }],
    derivedAttributes: demoPublishedPreset.derivedAttributes,
    now: new Date('2026-08-29T10:00:00.000Z'),
  }), /projection write failed/);

  assert.equal(statements.some((statement) => statement === 'COMMIT'), false);
  assert.equal(statements.at(-1), 'ROLLBACK');
});

test('PostgreSQL locks and persists only a real foreign Remix source pair', async () => {
  const statements: Array<{ text: string; values?: readonly unknown[] }> = [];
  const client = {
    async query(text: string, values?: readonly unknown[]) {
      statements.push({ text, values });
      if (text.includes('SELECT id, dimension')) {
        return { rows: [{ id: 'tone-crunch', dimension: 'tone', name_zh: 'Crunch', name_en: 'Crunch' }] };
      }
      if (text.includes('source_revision.id AS source_revision_id')) {
        return { rows: [{
          source_preset_id: demoPublishedPreset.id,
          source_revision_id: demoPublishedPreset.currentRevision.id,
          source_title: demoPublishedPreset.title,
          source_visibility: 'public',
          source_creator_id: demoPublishedPreset.creator.id,
          source_creator_handle: demoPublishedPreset.creator.handle,
          source_creator_display_name: demoPublishedPreset.creator.displayName,
        }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = { async connect() { return client; } } as unknown as Pool;
  const repository = createPostgresPublishedPresetPublicationRepository(pool);

  const created = await repository.create({
    id: 'preset-ada-remix',
    revisionId: 'revision-ada-remix-1',
    creator: { id: 'member-ada', handle: 'ada', displayName: 'Ada' },
    title: 'Ada Remix',
    description: '',
    tagIds: ['tone-crunch'],
    schemaVersion: 5,
    rig: demoPublishedPreset.currentRevision.rig,
    resourceDependencies: [{ kind: 'builtin' }],
    derivedAttributes: demoPublishedPreset.derivedAttributes,
    source: {
      presetId: demoPublishedPreset.id,
      revisionId: demoPublishedPreset.currentRevision.id,
    },
    now: new Date('2026-08-29T10:00:00.000Z'),
  });

  assert.equal(created.source?.presetId, demoPublishedPreset.id);
  const insert = statements.find((statement) => statement.text.includes(
    'INSERT INTO marketplace_published_presets',
  ));
  assert.deepEqual(insert?.values?.slice(6, 8), [
    demoPublishedPreset.id,
    demoPublishedPreset.currentRevision.id,
  ]);
  assert.equal(statements.at(-1)?.text.trim(), 'COMMIT');

  const forgedClient = {
    async query(text: string) {
      if (text.includes('SELECT id, dimension')) {
        return { rows: [{ id: 'tone-crunch', dimension: 'tone', name_zh: 'Crunch', name_en: 'Crunch' }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const forgedRepository = createPostgresPublishedPresetPublicationRepository({
    async connect() { return forgedClient; },
  } as unknown as Pool);
  await assert.rejects(() => forgedRepository.create({
    id: 'preset-forged',
    revisionId: 'revision-forged-1',
    creator: { id: 'member-ada', handle: 'ada', displayName: 'Ada' },
    title: 'Forged',
    description: '',
    tagIds: ['tone-crunch'],
    schemaVersion: 5,
    rig: demoPublishedPreset.currentRevision.rig,
    resourceDependencies: [{ kind: 'builtin' }],
    derivedAttributes: demoPublishedPreset.derivedAttributes,
    source: { presetId: 'missing', revisionId: 'missing' },
    now: new Date('2026-08-29T10:00:00.000Z'),
  }), PublishedPresetSourceError);
});

test('PostgreSQL revision append rolls back the immutable row when projection replacement fails', async () => {
  const statements: string[] = [];
  const client = {
    async query(text: string) {
      statements.push(text);
      if (text.includes('SELECT current_revision_id')) {
        return { rows: [{
          current_revision_id: demoPublishedPreset.currentRevision.id,
          updated_at: demoPublishedPreset.updatedAt,
          visibility: 'public',
        }] };
      }
      if (text.includes('marketplace_published_preset_search_projection')) {
        throw new Error('projection replacement failed');
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = { async connect() { return client; } } as unknown as Pool;
  const repository = createPostgresPublishedPresetPublicationRepository(pool);

  await assert.rejects(() => repository.appendRevision({
    presetId: demoPublishedPreset.id,
    creatorId: demoPublishedPreset.creator.id,
    revisionId: 'revision-demo-crunch-2',
    schemaVersion: demoPublishedPreset.currentRevision.schemaVersion,
    rig: demoPublishedPreset.currentRevision.rig,
    resourceDependencies: demoPublishedPreset.currentRevision.resourceDependencies,
    derivedAttributes: demoPublishedPreset.derivedAttributes,
    expectedUpdatedAt: new Date(demoPublishedPreset.updatedAt),
    now: new Date('2026-08-29T12:00:00.000Z'),
  }), /projection replacement failed/);

  assert.equal(statements.some((text) => text.includes('INSERT INTO marketplace_published_preset_revisions')), true);
  assert.equal(statements.some((text) => text.includes("updated_at + interval '1 millisecond'")), true);
  assert.equal(statements.some((text) => text.trim() === 'COMMIT'), false);
  assert.equal(statements.at(-1)?.trim(), 'ROLLBACK');
});

test('PostgreSQL optimistic conflict aborts before appending a revision', async () => {
  const statements: string[] = [];
  const client = {
    async query(text: string) {
      statements.push(text);
      if (text.includes('SELECT current_revision_id')) {
        return { rows: [{
          current_revision_id: 'revision-newer',
          updated_at: '2026-08-29T13:00:00.000Z',
          visibility: 'unlisted',
        }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = { async connect() { return client; } } as unknown as Pool;
  const repository = createPostgresPublishedPresetPublicationRepository(pool);

  await assert.rejects(() => repository.appendRevision({
    presetId: demoPublishedPreset.id,
    creatorId: demoPublishedPreset.creator.id,
    revisionId: 'revision-should-not-exist',
    schemaVersion: demoPublishedPreset.currentRevision.schemaVersion,
    rig: demoPublishedPreset.currentRevision.rig,
    resourceDependencies: demoPublishedPreset.currentRevision.resourceDependencies,
    derivedAttributes: demoPublishedPreset.derivedAttributes,
    expectedUpdatedAt: new Date(demoPublishedPreset.updatedAt),
    now: new Date('2026-08-29T14:00:00.000Z'),
  }), (cause) => cause instanceof PublishedPresetConflictError
    && cause.current.currentRevisionId === 'revision-newer'
    && cause.current.visibility === 'unlisted');

  assert.equal(statements.some((text) => text.includes('INSERT INTO marketplace_published_preset_revisions')), false);
  assert.equal(statements.at(-1)?.trim(), 'ROLLBACK');
});

test('PostgreSQL restore rejects a corrupted dependency snapshot before inserting', async () => {
  const statements: string[] = [];
  const client = {
    async query(text: string) {
      statements.push(text);
      if (text.includes('SELECT current_revision_id')) {
        return { rows: [{
          current_revision_id: 'revision-clean-current',
          updated_at: '2026-08-29T13:00:00.000Z',
          visibility: 'public',
        }] };
      }
      if (text.includes('SELECT id, schema_version')) {
        return { rows: [{
          id: demoPublishedPreset.currentRevision.id,
          schema_version: demoPublishedPreset.currentRevision.schemaVersion,
          resource_dependencies: [
            { kind: 'builtin' },
            { kind: 'tone3000', toneId: '999' },
          ],
          derived_attributes: demoPublishedPreset.currentRevision.derivedAttributes,
          rig: demoPublishedPreset.currentRevision.rig,
          created_at: demoPublishedPreset.currentRevision.createdAt,
        }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = { async connect() { return client; } } as unknown as Pool;
  const repository = createPostgresPublishedPresetPublicationRepository(pool);

  await assert.rejects(() => repository.restoreRevision({
    presetId: demoPublishedPreset.id,
    creatorId: demoPublishedPreset.creator.id,
    sourceRevisionId: demoPublishedPreset.currentRevision.id,
    revisionId: 'revision-must-not-exist',
    expectedUpdatedAt: new Date('2026-08-29T13:00:00.000Z'),
    now: new Date('2026-08-29T14:00:00.000Z'),
  }));

  assert.equal(statements.some((text) => text.includes('INSERT INTO marketplace_published_preset_revisions')), false);
  assert.equal(statements.at(-1)?.trim(), 'ROLLBACK');
});
