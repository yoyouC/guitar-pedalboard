import { createBetterAuthSessionVerifier } from '../server/auth/betterAuthSession.js';
import { hasCanonicalOrigin } from '../server/auth/api.js';
import { authenticationBaseURL, createRuntimeAuth } from '../server/auth/runtime.js';
import { marketplacePool } from '../server/marketplace/postgres.js';
import { createPostgresMemberRepository } from '../server/members/postgresRepository.js';
import { createMarketplaceModerationApi } from '../server/moderation/api.js';
import { createPostgresMarketplaceModerationRepository } from '../server/moderation/postgresRepository.js';
import { parseMarketplaceTrendingPolicy } from '../server/trending/policy.js';
import { createPostgresMarketplaceWriteLimiter } from '../server/abuse/postgresWriteLimiter.js';
import { parseMarketplaceWritePolicies } from '../server/abuse/policy.js';

let api: ReturnType<typeof createMarketplaceModerationApi> | null = null;

export default {
  async fetch(request: Request): Promise<Response> {
    if (!marketplacePool) return unavailable();
    const url = new URL(request.url);
    const route = url.searchParams.get('route');
    const pathname = ROUTE[route ?? ''];
    if (!pathname) return new Response(null, { status: 404 });
    url.pathname = pathname;
    url.searchParams.delete('route');
    if (request.method !== 'GET' && route !== 'notice'
      && !hasCanonicalOrigin(request, authenticationBaseURL())) {
      return Response.json(
        { error: { code: 'untrusted_auth_origin', message: 'Authentication origin is not trusted' } },
        { status: 403 },
      );
    }
    try {
      if (!api) {
        const auth = createRuntimeAuth(marketplacePool);
        api = createMarketplaceModerationApi({
          repository: createPostgresMarketplaceModerationRepository(
            marketplacePool,
            parseMarketplaceTrendingPolicy(process.env),
          ),
          sessions: createBetterAuthSessionVerifier(auth.api),
          members: createPostgresMemberRepository(marketplacePool),
          adminAuthUserIds: new Set(
            (process.env.MARKETPLACE_ADMIN_AUTH_USER_IDS ?? '')
              .split(',').map((value) => value.trim()).filter(Boolean),
          ),
          now: () => new Date(),
          createId: () => crypto.randomUUID(),
          createMemberId: () => crypto.randomUUID(),
          createHandleSuffix: () => crypto.randomUUID().replaceAll('-', '').slice(0, 8),
          writeLimiter: createPostgresMarketplaceWriteLimiter(
            marketplacePool,
            parseMarketplaceWritePolicies(process.env),
          ),
        });
      }
      return await api.fetch(new Request(url, request));
    } catch {
      return unavailable();
    }
  },
};

const ROUTE: Record<string, string> = {
  reports: '/api/marketplace/reports',
  notice: '/api/marketplace/infringement-notices',
  mine: '/api/marketplace/me/moderation',
  appeals: '/api/marketplace/moderation/appeals',
  queue: '/api/marketplace/admin/moderation/queue',
  actions: '/api/marketplace/admin/moderation/actions',
  'admin-appeals': '/api/marketplace/admin/moderation/appeals',
  audit: '/api/marketplace/admin/moderation/audit',
};

function unavailable(): Response {
  return Response.json(
    { error: { code: 'marketplace_unavailable', message: 'Marketplace is temporarily unavailable' } },
    { status: 503 },
  );
}
