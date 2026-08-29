export interface MarketplaceHealthApi {
  fetch(request: Request): Promise<Response>;
}

export async function probeMarketplaceStorage(
  database: { query(config: { text: string; query_timeout: number }): Promise<unknown> },
  timeoutMs = 2_000,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      database.query({
        text: `SELECT EXISTS (
           SELECT 1
           FROM marketplace_published_presets AS preset
           LEFT JOIN marketplace_published_preset_revisions AS revision
             ON revision.preset_id = preset.id
            AND revision.id = preset.current_revision_id
           LIMIT 1
         ) AS marketplace_schema_ready`,
        query_timeout: timeoutMs,
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Marketplace storage probe timed out')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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
