import { createMarketplaceApi } from '../server/marketplace/api.ts';
import { createBetterAuthSessionVerifier } from '../server/auth/betterAuthSession.ts';
import { hasCanonicalOrigin } from '../server/auth/api.ts';
import { authenticationBaseURL, createRuntimeAuth } from '../server/auth/runtime.ts';
import { marketplacePool } from '../server/marketplace/postgres.ts';
import {
  createPostgresPublishedPresetPublicationRepository,
  createPostgresPublishedPresetRepository,
} from '../server/marketplace/postgresRepository.ts';
import { createPostgresMemberRepository } from '../server/members/postgresRepository.ts';

let publicApi: ReturnType<typeof createMarketplaceApi> | null = null;
let privateApi: ReturnType<typeof createMarketplaceApi> | null = null;

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
    const revisionId = requestUrl.searchParams.get('revisionId');
    if (route === 'preset' && id) {
      requestUrl.pathname = `/api/marketplace/presets/${encodeURIComponent(id)}`;
    } else if (route === 'revision' && id && revisionId) {
      requestUrl.pathname = `/api/marketplace/presets/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}`;
    } else if (route === 'revision-restore' && id && revisionId) {
      requestUrl.pathname = `/api/marketplace/presets/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}/restore`;
    } else if (route === 'revisions' && id) {
      requestUrl.pathname = `/api/marketplace/presets/${encodeURIComponent(id)}/revisions`;
    } else if (route === 'metadata' && id) {
      requestUrl.pathname = `/api/marketplace/presets/${encodeURIComponent(id)}/metadata`;
    } else if (route === 'manage' && id) {
      requestUrl.pathname = `/api/marketplace/presets/${encodeURIComponent(id)}/manage`;
    } else if (route === 'visibility' && id) {
      requestUrl.pathname = `/api/marketplace/presets/${encodeURIComponent(id)}/visibility`;
    } else if (route === 'presets') {
      requestUrl.pathname = '/api/marketplace/presets';
    } else if (route === 'my-tones') {
      requestUrl.pathname = '/api/marketplace/me/tones';
    } else if (route === 'tags') {
      requestUrl.pathname = '/api/marketplace/tags';
    } else return new Response(null, { status: 404 });
    requestUrl.search = '';

    if (!marketplacePool) return unavailable();

    try {
      const reads = createPostgresPublishedPresetRepository(marketplacePool);
      const publications = createPostgresPublishedPresetPublicationRepository(marketplacePool);
      const isPrivateRoute = request.method === 'POST'
        || request.method === 'PATCH'
        || route === 'revisions'
        || route === 'manage'
        || route === 'my-tones';
      if (isPrivateRoute) {
        const baseURL = authenticationBaseURL();
        if (!hasCanonicalOrigin(request, baseURL)) {
          return Response.json(
            { error: { code: 'untrusted_auth_origin', message: 'Authentication origin is not trusted' } },
            { status: 403 },
          );
        }
        if (!privateApi) {
          const auth = createRuntimeAuth(marketplacePool);
          privateApi = createMarketplaceApi({
            publishedPresets: reads,
            publication: {
              repository: publications,
              sessions: createBetterAuthSessionVerifier(auth.api),
              members: createPostgresMemberRepository(marketplacePool),
              now: () => new Date(),
              createPresetId: () => `preset-${crypto.randomUUID()}`,
              createRevisionId: () => `revision-${crypto.randomUUID()}`,
              createMemberId: () => crypto.randomUUID(),
              createHandleSuffix: () => crypto.randomUUID().replaceAll('-', '').slice(0, 8),
            },
          });
        }
        return privateApi.fetch(new Request(requestUrl, request));
      }
      publicApi ??= createMarketplaceApi({
        publishedPresets: reads,
        availableTags: publications,
      });
      return publicApi.fetch(new Request(requestUrl, request));
    } catch {
      return unavailable();
    }
  },
};
