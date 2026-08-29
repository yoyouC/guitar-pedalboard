import { Pool } from 'pg';
import { rebuildPublishedPresetSearchProjection } from '../server/search/postgresRepository.ts';

const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!connectionString) throw new Error('Set DATABASE_URL or POSTGRES_URL');

const pool = new Pool({ connectionString });
try {
  await rebuildPublishedPresetSearchProjection(pool, new Date());
  console.log('Marketplace preset search projection rebuilt');
} finally {
  await pool.end();
}
