export interface MarketplaceHealthApi {
  fetch(request: Request): Promise<Response>;
}

export function createMarketplaceHealthApi(input: {
  probe(): Promise<void>;
}): MarketplaceHealthApi {
  return {
    async fetch(request) {
      if (request.method !== 'GET' || new URL(request.url).pathname !== '/api/marketplace/health') {
        return new Response(null, { status: 404 });
      }
      try {
        await input.probe();
        return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
      } catch {
        return Response.json({
          error: {
            code: 'marketplace_unavailable',
            message: 'Marketplace is temporarily unavailable',
          },
        }, { status: 503, headers: { 'cache-control': 'no-store' } });
      }
    },
  };
}
