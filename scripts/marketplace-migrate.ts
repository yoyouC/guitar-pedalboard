import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { applyMarketplaceMigrations } from '../server/operations/migrations.ts';

const connectionString = process.env.MARKETPLACE_MIGRATION_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? process.env.POSTGRES_URL;
if (!connectionString) {
  throw new Error('Set MARKETPLACE_MIGRATION_DATABASE_URL, DATABASE_URL or POSTGRES_URL');
}

const migrationsUrl = new URL('../server/marketplace/migrations/', import.meta.url);
const migrationFiles = (await readdir(migrationsUrl))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();
const pool = new Pool({ connectionString });

try {
  const migrations = await Promise.all(migrationFiles.map(async (name) => ({
    name,
    sql: await readFile(new URL(name, migrationsUrl), 'utf8'),
  })));
  const result = await applyMarketplaceMigrations(
    pool,
    migrations,
    (name) => console.log(`Marketplace migration ${name} applied`),
  );
  if (result.applied.length === 0) {
    console.log(`Marketplace schema is current (${result.skipped.length} migrations verified)`);
  }
} finally {
  await pool.end();
}
