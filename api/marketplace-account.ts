import { createMarketplaceAccountApi } from '../server/accounts/api.js';
import { createPostgresMarketplaceAccountRepository } from '../server/accounts/postgresRepository.js';
import { hasCanonicalOrigin } from '../server/auth/api.js';
import { createBetterAuthSessionVerifier } from '../server/auth/betterAuthSession.js';
import { authenticationBaseURL, createRuntimeAuth } from '../server/auth/runtime.js';
import { marketplacePool } from '../server/marketplace/postgres.js';
import { parseMarketplaceTrendingPolicy } from '../server/trending/policy.js';

let api: ReturnType<typeof createMarketplaceAccountApi> | null = null;

function unavailable(): Response {
  return Response.json(
    { error: { code: 'marketplace_unavailable', message: 'Marketplace is temporarily unavailable' } },
    { status: 503 },
  );
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (!marketplacePool) return unavailable();
    const url = new URL(request.url);
    const route = url.searchParams.get('route');
    if (route === 'export') url.pathname = '/api/marketplace/me/export';
    else if (route === 'deletion') url.pathname = '/api/marketplace/me/deletion';
    else if (route === 'purge') url.pathname = '/api/internal/marketplace/purge-deleted-accounts';
    else return new Response(null, { status: 404 });
    url.search = '';

    if (route !== 'purge' && !hasCanonicalOrigin(request, authenticationBaseURL())) {
      return Response.json(
        { error: { code: 'untrusted_auth_origin', message: 'Authentication origin is not trusted' } },
        { status: 403 },
      );
    }
    try {
      api ??= createMarketplaceAccountApi({
        repository: createPostgresMarketplaceAccountRepository(
          marketplacePool,
          parseMarketplaceTrendingPolicy(process.env),
        ),
        sessions: createBetterAuthSessionVerifier(createRuntimeAuth(marketplacePool).api),
        now: () => new Date(),
        cronSecret: process.env.CRON_SECRET,
      });
      return await api.fetch(new Request(url, request));
    } catch {
      return unavailable();
    }
  },
};
