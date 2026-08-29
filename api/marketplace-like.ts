import { createBetterAuthSessionVerifier } from '../server/auth/betterAuthSession.ts';
import { hasCanonicalOrigin } from '../server/auth/api.ts';
import { authenticationBaseURL, createRuntimeAuth } from '../server/auth/runtime.ts';
import { createMarketplaceLikesApi } from '../server/likes/api.ts';
import { createPostgresMarketplaceLikeRepository } from '../server/likes/postgresRepository.ts';
import { createPostgresMarketplaceTrendingRepository } from '../server/trending/postgresRepository.ts';
import { marketplacePool } from '../server/marketplace/postgres.ts';
import { createPostgresMemberRepository } from '../server/members/postgresRepository.ts';

let api: ReturnType<typeof createMarketplaceLikesApi> | null = null;

const unavailable = () => Response.json(
  { error: { code: 'marketplace_unavailable', message: 'Marketplace is temporarily unavailable' } },
  { status: 503 },
);

export default {
  async fetch(request: Request): Promise<Response> {
    if (!marketplacePool) return unavailable();
    const url = new URL(request.url);
    const route = url.searchParams.get('route');
    const id = url.searchParams.get('id');
    if (route === 'like-preset' && id) url.pathname = `/api/marketplace/likes/presets/${encodeURIComponent(id)}`;
    else if (route === 'like-collection' && id) url.pathname = `/api/marketplace/likes/collections/${encodeURIComponent(id)}`;
    else if (route === 'popular-presets') url.pathname = '/api/marketplace/popular/presets';
    else if (route === 'popular-collections') url.pathname = '/api/marketplace/popular/collections';
    else if (route === 'trending-presets') url.pathname = '/api/marketplace/trending/presets';
    else if (route === 'trending-collections') url.pathname = '/api/marketplace/trending/collections';
    else if (route === 'mine') url.pathname = '/api/marketplace/me/likes';
    else return new Response(null, { status: 404 });
    url.searchParams.delete('route');
    url.searchParams.delete('id');

    const privateRequest = request.method === 'PUT' || request.method === 'DELETE' || route === 'mine';
    if (privateRequest && !hasCanonicalOrigin(request, authenticationBaseURL())) {
      return Response.json(
        { error: { code: 'untrusted_auth_origin', message: 'Authentication origin is not trusted' } },
        { status: 403 },
      );
    }
    try {
      if (!api) {
        const auth = createRuntimeAuth(marketplacePool);
        api = createMarketplaceLikesApi({
          repository: createPostgresMarketplaceLikeRepository(marketplacePool),
          trending: createPostgresMarketplaceTrendingRepository(marketplacePool),
          sessions: createBetterAuthSessionVerifier(auth.api),
          members: createPostgresMemberRepository(marketplacePool),
          now: () => new Date(),
          createMemberId: () => crypto.randomUUID(),
          createHandleSuffix: () => crypto.randomUUID().replaceAll('-', '').slice(0, 8),
        });
      }
      return api.fetch(new Request(url, request));
    } catch {
      return unavailable();
    }
  },
};
