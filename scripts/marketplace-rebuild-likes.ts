import { Pool } from 'pg';
import { rebuildMarketplaceLikeCounts } from '../server/likes/postgresRepository.ts';

const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!connectionString) throw new Error('Set DATABASE_URL or POSTGRES_URL');
const pool = new Pool({ connectionString });
try {
  await rebuildMarketplaceLikeCounts(pool, new Date());
  console.log('Marketplace like counts rebuilt');
} finally {
  await pool.end();
}
