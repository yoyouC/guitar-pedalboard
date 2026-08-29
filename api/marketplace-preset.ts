import { createMarketplaceApi } from '../server/marketplace/api.ts';
import { marketplacePool } from '../server/marketplace/postgres.ts';
import { createPostgresPublishedPresetRepository } from '../server/marketplace/postgresRepository.ts';

export default {
  fetch(request: Request): Promise<Response> {
    const requestUrl = new URL(request.url);
    const id = requestUrl.searchParams.get('id');
    if (!id) return Promise.resolve(new Response(null, { status: 404 }));

    if (!marketplacePool) {
      return Promise.resolve(
        Response.json(
          {
            error: {
              code: 'marketplace_unavailable',
              message: 'Marketplace is temporarily unavailable',
            },
          },
          { status: 503 },
        ),
      );
    }

    requestUrl.pathname = `/api/marketplace/presets/${encodeURIComponent(id)}`;
    const api = createMarketplaceApi({
      publishedPresets: createPostgresPublishedPresetRepository(marketplacePool),
    });
    return api.fetch(new Request(requestUrl, request));
  },
};
