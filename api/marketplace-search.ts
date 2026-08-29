import { marketplacePool } from '../server/marketplace/postgres.ts';
import { createPublishedPresetSearchApi } from '../server/search/api.ts';
import { createPostgresPublishedPresetSearchRepository } from '../server/search/postgresRepository.ts';

let searchApi: ReturnType<typeof createPublishedPresetSearchApi> | null = null;

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
    requestUrl.pathname = '/api/marketplace/search/presets';
    try {
      searchApi ??= createPublishedPresetSearchApi({
        presets: createPostgresPublishedPresetSearchRepository(marketplacePool),
      });
      return searchApi.fetch(new Request(requestUrl, request));
    } catch {
      return unavailable();
    }
  },
};
