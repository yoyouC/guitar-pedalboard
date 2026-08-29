import { Pool } from 'pg';
import { rebuildMarketplaceTrending } from '../server/trending/postgresRepository.ts';
import { parseMarketplaceTrendingPolicy } from '../server/trending/policy.ts';

const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!connectionString) throw new Error('Set DATABASE_URL or POSTGRES_URL');
const pool = new Pool({ connectionString });
try {
  await rebuildMarketplaceTrending(pool, {
    now: new Date(),
    policy: parseMarketplaceTrendingPolicy(process.env),
  });
  console.log('Marketplace Trending snapshots rebuilt');
} finally {
  await pool.end();
}
