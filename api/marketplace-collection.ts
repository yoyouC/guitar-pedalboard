import { createBetterAuthSessionVerifier } from '../server/auth/betterAuthSession.js';
import { hasCanonicalOrigin } from '../server/auth/api.js';
import { authenticationBaseURL, createRuntimeAuth } from '../server/auth/runtime.js';
import { createPresetCollectionApi } from '../server/collections/api.js';
import {
  createPostgresPresetCollectionManagementRepository,
  createPostgresPresetCollectionRepository,
} from '../server/collections/postgresRepository.js';
import { marketplacePool } from '../server/marketplace/postgres.js';
import { createPostgresMemberRepository } from '../server/members/postgresRepository.js';

let publicApi: ReturnType<typeof createPresetCollectionApi> | null = null;
let privateApi: ReturnType<typeof createPresetCollectionApi> | null = null;

function unavailable(): Response {
  return Response.json(
    { error: { code: 'marketplace_unavailable', message: 'Marketplace is temporarily unavailable' } },
    { status: 503 },
  );
}

export default {
  async fetch(request: Request): Promise<Response> {
    const requestUrl = new URL(request.url);
    const route = requestUrl.searchParams.get('route');
    const id = requestUrl.searchParams.get('id');
    if (route === 'collection' && id) {
      requestUrl.pathname = `/api/marketplace/collections/${encodeURIComponent(id)}`;
    } else if (route === 'manage' && id) {
      requestUrl.pathname = `/api/marketplace/collections/${encodeURIComponent(id)}/manage`;
    } else if (route === 'collections') {
      requestUrl.pathname = '/api/marketplace/collections';
    } else if (route === 'my-collections') {
      requestUrl.pathname = '/api/marketplace/me/collections';
    } else return new Response(null, { status: 404 });
    requestUrl.search = '';

    if (!marketplacePool) return unavailable();
    try {
      const reads = createPostgresPresetCollectionRepository(marketplacePool);
      const isPrivate = request.method === 'POST'
        || request.method === 'PATCH'
        || route === 'manage'
        || route === 'my-collections';
      if (isPrivate) {
        const baseURL = authenticationBaseURL();
        if (!hasCanonicalOrigin(request, baseURL)) {
          return Response.json(
            { error: { code: 'untrusted_auth_origin', message: 'Authentication origin is not trusted' } },
            { status: 403 },
          );
        }
        if (!privateApi) {
          const auth = createRuntimeAuth(marketplacePool);
          const management = createPostgresPresetCollectionManagementRepository(marketplacePool);
          privateApi = createPresetCollectionApi({
            collections: reads,
            management: {
              repository: management,
              sessions: createBetterAuthSessionVerifier(auth.api),
              members: createPostgresMemberRepository(marketplacePool),
              now: () => new Date(),
              createCollectionId: () => `collection-${crypto.randomUUID()}`,
              createMemberId: () => crypto.randomUUID(),
              createHandleSuffix: () => crypto.randomUUID().replaceAll('-', '').slice(0, 8),
            },
          });
        }
        return privateApi.fetch(new Request(requestUrl, request));
      }
      publicApi ??= createPresetCollectionApi({ collections: reads });
      return publicApi.fetch(new Request(requestUrl, request));
    } catch {
      return unavailable();
    }
  },
};
