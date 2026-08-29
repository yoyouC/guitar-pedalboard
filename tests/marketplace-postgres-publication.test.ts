import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { createPostgresPublishedPresetPublicationRepository } from '../server/marketplace/postgresRepository.ts';
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
