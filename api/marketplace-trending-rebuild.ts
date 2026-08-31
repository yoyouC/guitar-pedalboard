import { marketplacePool } from '../server/marketplace/postgres.js';
import { rebuildMarketplaceTrending } from '../server/trending/postgresRepository.js';
import { createMarketplaceTrendingRebuildApi } from '../server/trending/rebuildApi.js';
import { parseMarketplaceTrendingPolicy } from '../server/trending/policy.js';

const api = createMarketplaceTrendingRebuildApi({
  secret: process.env.CRON_SECRET,
  now: () => new Date(),
  rebuild: async (now) => {
    if (!marketplacePool) throw new Error('Marketplace database is not configured');
    await rebuildMarketplaceTrending(marketplacePool, {
      now,
      policy: parseMarketplaceTrendingPolicy(process.env),
    });
  },
});

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await api.fetch(request);
    } catch {
      return Response.json(
        { error: { code: 'marketplace_unavailable', message: 'Marketplace is temporarily unavailable' } },
        { status: 503 },
      );
    }
  },
};
