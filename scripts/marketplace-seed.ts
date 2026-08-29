import { Pool } from 'pg';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';
import { seedPublishedPreset } from '../server/marketplace/seed.ts';

const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!connectionString) throw new Error('Set DATABASE_URL or POSTGRES_URL');

const pool = new Pool({ connectionString });
const client = await pool.connect();

try {
  await client.query('BEGIN');
  await seedPublishedPreset(client, demoPublishedPreset);
  await client.query('COMMIT');
  console.log(`Seeded ${demoPublishedPreset.id}`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
