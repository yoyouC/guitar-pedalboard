import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Client, Pool } from 'pg';
import { createMarketplaceApi } from '../server/marketplace/api.ts';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';
import { createMemoryPublishedPresetRepository } from '../server/marketplace/memoryRepository.ts';
import { createMemoryMemberRepository } from '../server/members/memoryRepository.ts';
import { createPostgresMarketplaceWriteLimiter } from '../server/abuse/postgresWriteLimiter.ts';

const connectionString = process.env.MARKETPLACE_TEST_DATABASE_URL;

test('write-limit migration stores only hashed subjects', async () => {
  const sql = await readFile(
    new URL('../server/marketplace/migrations/0014_marketplace_write_limits.sql', import.meta.url),
    'utf8',
  );
  assert.match(sql, /subject_hash text NOT NULL/);
  assert.doesNotMatch(sql, /member_id|ip_address|network_source/);
});

test('PostgreSQL-backed publication limits arbitrate bursts and reject deleting members', {
  skip: connectionString ? false : 'Set MARKETPLACE_TEST_DATABASE_URL for PostgreSQL write-limit integration',
}, async () => {
  const admin = new Client({ connectionString });
  const schema = `marketplace_write_limit_${process.pid}_${Date.now()}`;
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  try {
    await pool.query(`CREATE TABLE marketplace_members (
      id text PRIMARY KEY,
      account_status text NOT NULL CHECK (account_status IN ('active', 'pending_deletion', 'tombstoned'))
    )`);
    await pool.query(await readFile(
      new URL('../server/marketplace/migrations/0014_marketplace_write_limits.sql', import.meta.url),
      'utf8',
    ));
    await pool.query(
      `INSERT INTO marketplace_members (id, account_status) VALUES ('member-private-id', 'active')`,
    );
    const limiter = createPostgresMarketplaceWriteLimiter(pool, {
      publish: {
        member: { refillPerMinute: 1, burst: 1 },
        network: { refillPerMinute: 1, burst: 1 },
      },
    });
    const tags = demoPublishedPreset.tags;
    const publications = createMemoryPublishedPresetRepository([], tags);
    const members = createMemoryMemberRepository([{
      id: 'member-private-id', authUserId: 'auth-private', handle: 'private-member',
      displayName: 'Private Member', bio: '', avatarUrl: null, handleChangedAt: null,
      termsAcceptedVersion: '2026-08-29',
      publicProfileCompletedAt: new Date('2026-08-29T09:00:00.000Z'),
      createdAt: new Date('2026-08-29T09:00:00.000Z'),
      updatedAt: new Date('2026-08-29T09:00:00.000Z'),
    }]);
    let now = new Date('2026-08-29T10:00:00.000Z');
    let presetSequence = 0;
    const api = createMarketplaceApi({
      publishedPresets: publications,
      publication: {
        repository: publications,
        sessions: { async verify() { return {
          authUserId: 'auth-private', email: 'private@example.test', emailVerified: true,
          displayName: 'Private Member', avatarUrl: null,
        }; } },
        members,
        now: () => now,
        createPresetId: () => `preset-private-${++presetSequence}`,
        createRevisionId: () => `revision-private-${presetSequence}`,
        createMemberId: () => 'unused-member-id',
        createHandleSuffix: () => 'unused01',
        writeLimiter: limiter,
      },
    });
    const publish = () => api.fetch(new Request(
      'https://pedalboard.test/api/marketplace/presets', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.19' },
        body: JSON.stringify({
          title: 'Private member tone', description: '',
          tagIds: tags.slice(0, 1).map((tag) => tag.id),
          schemaVersion: demoPublishedPreset.currentRevision.schemaVersion,
          rig: demoPublishedPreset.currentRevision.rig,
        }),
      },
    ));

    const simultaneous = await Promise.all([publish(), publish()]);
    assert.deepEqual(simultaneous.map((response) => response.status).sort(), [201, 429]);
    const denied = simultaneous.find((response) => response.status === 429)!;
    assert.equal(denied.headers.get('retry-after'), '60');
    assert.equal((await denied.json()).error.retryAt, '2026-08-29T10:01:00.000Z');

    const rows = await pool.query<{ subject_hash: string }>(
      'SELECT subject_hash FROM marketplace_write_rate_buckets ORDER BY scope',
    );
    assert.equal(rows.rowCount, 2);
    assert.equal(rows.rows.some((row) => row.subject_hash.includes('member-private-id')), false);
    assert.equal(rows.rows.some((row) => row.subject_hash.includes('203.0.113.19')), false);

    await pool.query(
      `INSERT INTO marketplace_write_rate_buckets
         (operation, scope, subject_hash, tokens, updated_at)
       VALUES ('publish', 'network', $1, 0, $2)`,
      ['f'.repeat(64), new Date('2026-08-29T09:00:00.000Z')],
    );
    now = new Date('2026-08-29T10:01:00.000Z');
    assert.equal((await publish()).status, 201);
    assert.equal((await pool.query(
      `SELECT 1 FROM marketplace_write_rate_buckets WHERE subject_hash = $1`,
      ['f'.repeat(64)],
    )).rowCount, 0);

    now = new Date('2026-08-29T10:02:00.000Z');
    const deletion = await pool.connect();
    await deletion.query('BEGIN');
    await deletion.query(
      `SELECT id FROM marketplace_members WHERE id = 'member-private-id' FOR UPDATE`,
    );
    const inFlightWrite = publish();
    await deletion.query(
      `UPDATE marketplace_members SET account_status = 'pending_deletion'
       WHERE id = 'member-private-id'`,
    );
    await deletion.query('COMMIT');
    deletion.release();
    const deleting = await inFlightWrite;
    assert.equal(deleting.status, 403);
    assert.equal((await deleting.json()).error.code, 'account_deletion_pending');
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
