import { createBetterAuthSessionVerifier } from '../server/auth/betterAuthSession.js';
import { hasCanonicalOrigin } from '../server/auth/api.js';
import { authenticationBaseURL, createRuntimeAuth } from '../server/auth/runtime.js';
import { marketplacePool } from '../server/marketplace/postgres.js';
import { createMemberApi } from '../server/members/api.js';
import { createPostgresMemberRepository } from '../server/members/postgresRepository.js';
import { createPostgresPublicCreatorWorks } from '../server/members/works.js';

let privateApi: ReturnType<typeof createMemberApi> | null = null;
let publicApi: ReturnType<typeof createMemberApi> | null = null;

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
    const route = requestUrl.searchParams.get('route');
    const handle = requestUrl.searchParams.get('handle');
    const memberId = requestUrl.searchParams.get('memberId');
    if (route === 'me') requestUrl.pathname = '/api/marketplace/me';
    else if (route === 'profile') requestUrl.pathname = '/api/marketplace/me/profile';
    else if (route === 'creator' && handle) {
      requestUrl.pathname = `/api/marketplace/creators/${encodeURIComponent(handle)}`;
    } else if (route === 'creator-presets' && handle) {
      requestUrl.pathname = `/api/marketplace/creators/${encodeURIComponent(handle)}/presets`;
    } else if (route === 'creator-id' && memberId) {
      requestUrl.pathname = `/api/marketplace/creators/id/${encodeURIComponent(memberId)}`;
    } else if (route === 'creator-id-presets' && memberId) {
      requestUrl.pathname = `/api/marketplace/creators/id/${encodeURIComponent(memberId)}/presets`;
    } else return new Response(null, { status: 404 });
    requestUrl.search = '';

    try {
      if (
        route === 'creator'
        || route === 'creator-presets'
        || route === 'creator-id'
        || route === 'creator-id-presets'
      ) {
        publicApi ??= createMemberApi({
          members: createPostgresMemberRepository(marketplacePool),
          sessions: { async verify() { return null; } },
          now: () => new Date(),
          createId: () => crypto.randomUUID(),
          createHandleSuffix: () => crypto.randomUUID().replaceAll('-', '').slice(0, 8),
          publicWorks: createPostgresPublicCreatorWorks(marketplacePool),
        });
        return publicApi.fetch(new Request(requestUrl, request));
      }
      const baseURL = authenticationBaseURL();
      if (!hasCanonicalOrigin(request, baseURL)) {
        return Response.json(
          { error: { code: 'untrusted_auth_origin', message: 'Authentication origin is not trusted' } },
          { status: 403 },
        );
      }
      if (!privateApi) {
        const auth = createRuntimeAuth(marketplacePool);
        privateApi = createMemberApi({
          members: createPostgresMemberRepository(marketplacePool),
          sessions: createBetterAuthSessionVerifier(auth.api),
          now: () => new Date(),
          createId: () => crypto.randomUUID(),
          createHandleSuffix: () => crypto.randomUUID().replaceAll('-', '').slice(0, 8),
        });
      }
      return privateApi.fetch(new Request(requestUrl, request));
    } catch {
      return unavailable();
    }
  },
};
