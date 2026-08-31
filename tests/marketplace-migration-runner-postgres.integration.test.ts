import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { Client, Pool } from 'pg';
import {
  applyMarketplaceMigrations,
  MarketplaceMigrationChecksumError,
  type MarketplaceMigration,
} from '../server/operations/migrations.ts';

const connectionString = process.env.MARKETPLACE_TEST_DATABASE_URL;

async function loadMigrations(): Promise<MarketplaceMigration[]> {
  const migrationsUrl = new URL('../server/marketplace/migrations/', import.meta.url);
  const names = (await readdir(migrationsUrl))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  return Promise.all(names.map(async (name) => ({
    name,
    sql: await readFile(new URL(name, migrationsUrl), 'utf8'),
  })));
}

test('migration runner records checksums, serializes concurrency, and rejects drift', {
  skip: connectionString ? false : 'Set MARKETPLACE_TEST_DATABASE_URL for migration runner integration',
}, async () => {
  const admin = new Client({ connectionString });
  const schema = `marketplace_runner_${process.pid}_${Date.now()}`;
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  try {
    const migrations = await loadMigrations();
    const [first, second] = await Promise.all([
      applyMarketplaceMigrations(pool, migrations),
      applyMarketplaceMigrations(pool, migrations),
    ]);
    assert.equal(first.applied.length + second.applied.length, migrations.length);
    assert.equal(first.skipped.length + second.skipped.length, migrations.length);

    const ledger = await pool.query<{ name: string; sha256: string }>(
      'SELECT name, sha256 FROM marketplace_schema_migrations ORDER BY name',
    );
    assert.deepEqual(ledger.rows.map((row) => row.name), migrations.map(({ name }) => name));
    assert.ok(ledger.rows.every((row) => /^[0-9a-f]{64}$/.test(row.sha256)));

    const repeated = await applyMarketplaceMigrations(pool, migrations);
    assert.deepEqual(repeated, {
      applied: [],
      skipped: migrations.map(({ name }) => name),
    });

    const drifted = migrations.map((migration, index) => index === 0
      ? { ...migration, sql: `${migration.sql}\n-- rewritten after release` }
      : migration);
    await assert.rejects(
      applyMarketplaceMigrations(pool, drifted),
      (cause) => cause instanceof MarketplaceMigrationChecksumError
        && cause.migrationName === migrations[0].name,
    );
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
