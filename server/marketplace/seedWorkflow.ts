import { demoPublishedPreset } from './demoPreset.js';
import type { PostgresQueryable } from './postgresRepository.js';
import { seedPublishedPreset } from './seed.js';
import { rebuildPublishedPresetSearchProjection } from '../search/postgresRepository.js';

export interface MarketplaceSeedPool {
  connect(): Promise<PostgresQueryable & { release(): void }>;
}

export async function seedDemoMarketplace(
  pool: MarketplaceSeedPool,
  now: Date,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await seedPublishedPreset(client, demoPublishedPreset);
    await client.query('COMMIT');
  } catch (cause) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
    throw cause;
  } finally {
    client.release();
  }
  await rebuildPublishedPresetSearchProjection(pool, now);
}
