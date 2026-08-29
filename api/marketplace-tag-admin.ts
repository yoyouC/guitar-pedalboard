import { createBetterAuthSessionVerifier } from '../server/auth/betterAuthSession.ts';
import { hasCanonicalOrigin } from '../server/auth/api.ts';
import { authenticationBaseURL, createRuntimeAuth } from '../server/auth/runtime.ts';
import { marketplacePool } from '../server/marketplace/postgres.ts';
import { createMarketplaceTagAdministrationApi } from '../server/tags/api.ts';
import { createPostgresMarketplaceTagAdministrationRepository } from '../server/tags/postgresRepository.ts';

let api: ReturnType<typeof createMarketplaceTagAdministrationApi> | null = null;

export default {
  async fetch(request: Request): Promise<Response> {
    if (!marketplacePool) return unavailable();
    const url = new URL(request.url);
    const route = url.searchParams.get('route');
    const id = url.searchParams.get('id');
    if (route === 'tags') url.pathname = '/api/marketplace/admin/tags';
    else if (route === 'audit') url.pathname = '/api/marketplace/admin/tags/audit';
    else if (route === 'tag' && id) url.pathname = `/api/marketplace/admin/tags/${encodeURIComponent(id)}`;
    else if (route === 'deprecate' && id) url.pathname = `/api/marketplace/admin/tags/${encodeURIComponent(id)}/deprecate`;
    else if (route === 'merge' && id) url.pathname = `/api/marketplace/admin/tags/${encodeURIComponent(id)}/merge`;
    else return new Response(null, { status: 404 });
    url.search = '';
    if (request.method !== 'GET' && !hasCanonicalOrigin(request, authenticationBaseURL())) {
      return Response.json(
        { error: { code: 'untrusted_auth_origin', message: 'Authentication origin is not trusted' } },
        { status: 403 },
      );
    }
    try {
      if (!api) {
        const auth = createRuntimeAuth(marketplacePool);
        api = createMarketplaceTagAdministrationApi({
          repository: createPostgresMarketplaceTagAdministrationRepository(marketplacePool),
          sessions: createBetterAuthSessionVerifier(auth.api),
          adminAuthUserIds: new Set(
            (process.env.MARKETPLACE_ADMIN_AUTH_USER_IDS ?? '')
              .split(',').map((value) => value.trim()).filter(Boolean),
          ),
          now: () => new Date(),
          createAuditId: () => crypto.randomUUID(),
        });
      }
      return api.fetch(new Request(url, request));
    } catch {
      return unavailable();
    }
  },
};

function unavailable(): Response {
  return Response.json(
    { error: { code: 'marketplace_unavailable', message: 'Marketplace is temporarily unavailable' } },
    { status: 503 },
  );
}
