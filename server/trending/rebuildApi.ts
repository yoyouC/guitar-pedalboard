export interface MarketplaceTrendingRebuildApi {
  fetch(request: Request): Promise<Response>;
}

export function createMarketplaceTrendingRebuildApi(input: {
  secret: string | undefined;
  rebuild(now: Date): Promise<void>;
  now(): Date;
}): MarketplaceTrendingRebuildApi {
  return {
    async fetch(request) {
      if (request.method !== 'GET') return new Response(null, { status: 405 });
      if (!input.secret) {
        return Response.json(
          { error: { code: 'trending_rebuild_unconfigured', message: 'Trending rebuild is not configured' } },
          { status: 503 },
        );
      }
      if (request.headers.get('authorization') !== `Bearer ${input.secret}`) {
        return Response.json(
          { error: { code: 'authentication_required', message: 'Authentication required' } },
          { status: 401 },
        );
      }
      const now = input.now();
      await input.rebuild(now);
      return Response.json({ rebuiltAt: now.toISOString() });
    },
  };
}
