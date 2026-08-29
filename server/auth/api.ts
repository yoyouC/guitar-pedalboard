export interface AuthenticationHandler {
  handler(request: Request): Promise<Response>;
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
