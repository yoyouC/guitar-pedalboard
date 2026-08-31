import { createBetterAuthSessionVerifier } from '../server/auth/betterAuthSession.js';
import { hasCanonicalOrigin } from '../server/auth/api.js';
import { authenticationBaseURL, createRuntimeAuth } from '../server/auth/runtime.js';
import { createMarketplaceLikesApi } from '../server/likes/api.js';
import { createPostgresMarketplaceLikeRepository } from '../server/likes/postgresRepository.js';
import { createPostgresMarketplaceTrendingRepository } from '../server/trending/postgresRepository.js';
import { marketplacePool } from '../server/marketplace/postgres.js';
import { createPostgresMemberRepository } from '../server/members/postgresRepository.js';
import { createPostgresMarketplaceWriteLimiter } from '../server/abuse/postgresWriteLimiter.js';
import { parseMarketplaceWritePolicies } from '../server/abuse/policy.js';

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
          writeLimiter: createPostgresMarketplaceWriteLimiter(
            marketplacePool,
            parseMarketplaceWritePolicies(process.env),
          ),
        });
      }
      return api.fetch(new Request(url, request));
    } catch {
      return unavailable();
    }
  },
};
