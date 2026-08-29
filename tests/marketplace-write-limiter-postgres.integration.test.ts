import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Client, Pool } from 'pg';
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

test('PostgreSQL write limits atomically arbitrate first-use bursts and retry windows', {
  skip: connectionString ? false : 'Set MARKETPLACE_TEST_DATABASE_URL for PostgreSQL write-limit integration',
}, async () => {
  const admin = new Client({ connectionString });
  const schema = `marketplace_write_limit_${process.pid}_${Date.now()}`;
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  try {
    await pool.query(await readFile(
      new URL('../server/marketplace/migrations/0014_marketplace_write_limits.sql', import.meta.url),
      'utf8',
    ));
    const limiter = createPostgresMarketplaceWriteLimiter(pool, {
      publish: {
        member: { refillPerMinute: 1, burst: 1 },
        network: { refillPerMinute: 1, burst: 1 },
      },
    });
    const input = {
      operation: 'publish' as const,
      memberId: 'member-private-id',
      networkSource: '203.0.113.19',
      now: new Date('2026-08-29T10:00:00.000Z'),
    };
    const simultaneous = await Promise.all([limiter.consume(input), limiter.consume(input)]);
    assert.equal(simultaneous.filter((result) => result.allowed).length, 1);
    const denied = simultaneous.find((result) => !result.allowed);
    assert.equal(denied?.retryAt?.toISOString(), '2026-08-29T10:01:00.000Z');

    const rows = await pool.query<{ subject_hash: string }>(
      'SELECT subject_hash FROM marketplace_write_rate_buckets ORDER BY scope',
    );
    assert.equal(rows.rowCount, 2);
    assert.equal(rows.rows.some((row) => row.subject_hash.includes('member-private-id')), false);
    assert.equal(rows.rows.some((row) => row.subject_hash.includes('203.0.113.19')), false);

    assert.deepEqual(await limiter.consume({
      ...input, now: new Date('2026-08-29T10:01:00.000Z'),
    }), { allowed: true });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
