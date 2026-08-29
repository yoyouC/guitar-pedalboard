import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { createPostgresPublishedPresetPublicationRepository } from '../server/marketplace/postgresRepository.ts';
import { PublishedPresetConflictError } from '../server/marketplace/repository.ts';
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
