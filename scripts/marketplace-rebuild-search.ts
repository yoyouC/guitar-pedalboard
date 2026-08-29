import { Pool } from 'pg';
import { rebuildPublishedPresetSearchProjection } from '../server/search/postgresRepository.ts';
import { rebuildMarketplaceTextSearchProjection } from '../server/search/postgresTextProjection.ts';

const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!connectionString) throw new Error('Set DATABASE_URL or POSTGRES_URL');

const pool = new Pool({ connectionString });
try {
  await pool.query('BEGIN');
  await rebuildPublishedPresetSearchProjection(pool, new Date());
  await rebuildMarketplaceTextSearchProjection(pool);
  await pool.query('COMMIT');
  console.log('Marketplace Rig and text search projections rebuilt');
} catch (cause) {
  try { await pool.query('ROLLBACK'); } catch { /* preserve original error */ }
  throw cause;
} finally {
  await pool.end();
}
