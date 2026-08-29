import { demoPublishedPreset } from './demoPreset.ts';
import type { PostgresQueryable } from './postgresRepository.ts';
import { seedPublishedPreset } from './seed.ts';
import { rebuildPublishedPresetSearchProjection } from '../search/postgresRepository.ts';

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
