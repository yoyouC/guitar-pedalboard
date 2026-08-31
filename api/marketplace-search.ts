import { marketplacePool } from '../server/marketplace/postgres.js';
import { createMarketplaceSearchApi } from '../server/search/api.js';
import { createPostgresPublishedPresetSearchRepository } from '../server/search/postgresRepository.js';
import { createPostgresMarketplaceDiscoveryRepository } from '../server/search/postgresDiscoveryRepository.js';

let searchApi: ReturnType<typeof createMarketplaceSearchApi> | null = null;

function unavailable(): Response {
  return Response.json(
    { error: { code: 'marketplace_unavailable', message: 'Marketplace is temporarily unavailable' } },
    { status: 503 },
  );
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (!marketplacePool) return unavailable();
    const requestUrl = new URL(request.url);
    const route = requestUrl.searchParams.get('route') ?? 'presets';
    requestUrl.searchParams.delete('route');
    if (!['presets', 'collections', 'creators'].includes(route)) {
      return new Response(null, { status: 404 });
    }
    requestUrl.pathname = `/api/marketplace/search/${route}`;
    try {
      searchApi ??= createMarketplaceSearchApi({
        presets: createPostgresPublishedPresetSearchRepository(marketplacePool),
        discovery: createPostgresMarketplaceDiscoveryRepository(marketplacePool),
      });
      return searchApi.fetch(new Request(requestUrl, request));
    } catch {
      return unavailable();
    }
  },
};
