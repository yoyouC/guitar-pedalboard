import type { PlatformAuth } from './betterAuth.js';

export interface AuthenticationHandler {
  handler(request: Request): Promise<Response>;
}

export function createSessionBoundAuthenticationHandler(
  auth: PlatformAuth,
): AuthenticationHandler {
  return {
    async handler(request) {
      const url = new URL(request.url);
      if (
        request.method !== 'POST'
        || url.pathname !== '/api/auth/send-verification-email'
      ) return auth.handler(request);

      const session = await auth.api.getSession({ headers: request.headers });
      if (!session) {
        return Response.json(
          { error: { code: 'authentication_required', message: 'Authentication required' } },
          { status: 401 },
        );
      }

      let callbackURL: string | undefined;
      try {
        const body = await request.json() as { callbackURL?: unknown };
        if (body.callbackURL !== undefined && typeof body.callbackURL !== 'string') {
          throw new Error('invalid callback URL');
        }
        callbackURL = body.callbackURL;
      } catch {
        return Response.json(
          { error: { code: 'invalid_auth_request', message: 'Invalid authentication request' } },
          { status: 400 },
        );
      }

      return auth.handler(new Request(request, {
        body: JSON.stringify({
          email: session.user.email,
          ...(callbackURL === undefined ? {} : { callbackURL }),
        }),
      }));
    },
  };
}

export interface AuthenticationApi {
  fetch(request: Request): Promise<Response>;
}

export function hasCanonicalOrigin(request: Request, baseURL: URL): boolean {
  return new URL(request.url).origin === baseURL.origin;
}

export function createAuthenticationApi(
  baseURL: URL,
  auth: AuthenticationHandler,
): AuthenticationApi {
  return {
    async fetch(request) {
      if (!hasCanonicalOrigin(request, baseURL)) {
        return Response.json(
          { error: { code: 'untrusted_auth_origin', message: 'Authentication origin is not trusted' } },
          { status: 403 },
        );
      }
      const incoming = new URL(request.url);
      const path = incoming.searchParams.get('path') ?? '';
      const canonical = new URL(`/api/auth/${path}`, baseURL);
      incoming.searchParams.delete('path');
      canonical.search = incoming.search;
      return auth.handler(new Request(canonical, request));
    },
  };
}
