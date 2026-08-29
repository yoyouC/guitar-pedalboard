import { Pool } from 'pg';
import { rebuildAllMarketplaceProjections } from '../server/operations/postgresProjectionRebuild.ts';
import { parseMarketplaceTrendingPolicy } from '../server/trending/policy.ts';

const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!connectionString) throw new Error('Set DATABASE_URL or POSTGRES_URL');

const pool = new Pool({ connectionString });
try {
  await rebuildAllMarketplaceProjections(pool, {
    now: new Date(),
    trendingPolicy: parseMarketplaceTrendingPolicy(process.env),
  });
  console.log('Marketplace search, Like count, Popular, and Trending projections rebuilt atomically');
} finally {
  await pool.end();
}
