import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!connectionString) throw new Error('Set DATABASE_URL or POSTGRES_URL');

const migrationsUrl = new URL('../server/marketplace/migrations/', import.meta.url);
const migrationFiles = (await readdir(migrationsUrl))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();
const pool = new Pool({ connectionString });

try {
  for (const migrationFile of migrationFiles) {
    const sql = await readFile(new URL(migrationFile, migrationsUrl), 'utf8');
    await pool.query(sql);
    console.log(`Marketplace migration ${migrationFile} applied`);
  }
} finally {
  await pool.end();
}
