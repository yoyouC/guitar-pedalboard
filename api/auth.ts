import { marketplacePool } from '../server/marketplace/postgres.js';
import {
  createAuthenticationApi,
  createSessionBoundAuthenticationHandler,
} from '../server/auth/api.js';
import { authenticationBaseURL, createRuntimeAuth } from '../server/auth/runtime.js';

let authenticationApi: ReturnType<typeof createAuthenticationApi> | null = null;

function unavailable(): Response {
  return Response.json(
    { error: { code: 'authentication_unavailable', message: 'Authentication is unavailable' } },
    { status: 503 },
  );
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (!marketplacePool) return unavailable();
    try {
      authenticationApi ??= createAuthenticationApi(
        authenticationBaseURL(),
        createSessionBoundAuthenticationHandler(createRuntimeAuth(marketplacePool)),
      );
      return authenticationApi.fetch(request);
    } catch {
      return unavailable();
    }
  },
};
