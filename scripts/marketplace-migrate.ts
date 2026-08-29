import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!connectionString) throw new Error('Set DATABASE_URL or POSTGRES_URL');

const migrationUrl = new URL(
  '../server/marketplace/migrations/0001_published_presets.sql',
  import.meta.url,
);
const sql = await readFile(migrationUrl, 'utf8');
const pool = new Pool({ connectionString });

try {
  await pool.query(sql);
  console.log('Marketplace migration 0001 applied');
} finally {
  await pool.end();
}
