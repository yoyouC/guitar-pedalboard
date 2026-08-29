import { marketplacePool } from '../server/marketplace/postgres.ts';
import { rebuildMarketplaceTrending } from '../server/trending/postgresRepository.ts';
import { createMarketplaceTrendingRebuildApi } from '../server/trending/rebuildApi.ts';
import { parseMarketplaceTrendingPolicy } from '../server/trending/policy.ts';

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
