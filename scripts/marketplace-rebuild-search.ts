import { Pool } from 'pg';
import { rebuildPublishedPresetSearchProjectionInTransaction } from '../server/search/postgresRepository.ts';
import { rebuildMarketplaceTextSearchProjection } from '../server/search/postgresTextProjection.ts';

const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!connectionString) throw new Error('Set DATABASE_URL or POSTGRES_URL');

const pool = new Pool({ connectionString });
try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await rebuildPublishedPresetSearchProjectionInTransaction(client, new Date());
    await rebuildMarketplaceTextSearchProjection(client);
    await client.query('COMMIT');
  } catch (cause) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
    throw cause;
  } finally {
    client.release();
  }
  console.log('Marketplace Rig and text search projections rebuilt');
} finally {
  await pool.end();
}
