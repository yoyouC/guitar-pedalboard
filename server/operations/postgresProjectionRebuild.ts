import type { Pool } from 'pg';
import { rebuildMarketplaceLikeCountsInTransaction } from '../likes/postgresRepository.js';
import { rebuildPublishedPresetSearchProjectionInTransaction } from '../search/postgresRepository.js';
import { rebuildMarketplaceTextSearchProjection } from '../search/postgresTextProjection.js';
import type { MarketplaceTrendingPolicy } from '../trending/policy.js';
import { rebuildMarketplaceTrendingInTransaction } from '../trending/postgresRepository.js';

export async function rebuildAllMarketplaceProjections(
  pool: Pool,
  input: { now: Date; trendingPolicy: MarketplaceTrendingPolicy },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await rebuildPublishedPresetSearchProjectionInTransaction(client, input.now);
    await rebuildMarketplaceTextSearchProjection(client);
    await rebuildMarketplaceLikeCountsInTransaction(client, input.now);
    await rebuildMarketplaceTrendingInTransaction(client, {
      now: input.now,
      policy: input.trendingPolicy,
    });
    await client.query('COMMIT');
  } catch (cause) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
    throw cause;
  } finally {
    client.release();
  }
}
