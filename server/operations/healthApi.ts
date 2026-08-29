export interface MarketplaceHealthApi {
  fetch(request: Request): Promise<Response>;
}

export async function probeMarketplaceStorage(
  database: {
    connect(): Promise<{
      query(config: string | { text: string; query_timeout: number }, values?: unknown[]): Promise<unknown>;
      release(destroy?: boolean): void;
    }>;
  },
  timeoutMs = 2_000,
): Promise<void> {
  const connection = database.connect();
  let connectionTimer: ReturnType<typeof setTimeout> | undefined;
  let client: Awaited<ReturnType<typeof database.connect>>;
  try {
    client = await Promise.race([
      connection,
      new Promise<never>((_resolve, reject) => {
        connectionTimer = setTimeout(
          () => reject(new Error('Marketplace storage connection timed out')),
          timeoutMs,
        );
      }),
    ]);
  } catch (cause) {
    void connection.then((lateClient) => lateClient.release(true), () => undefined);
    throw cause;
  } finally {
    if (connectionTimer) clearTimeout(connectionTimer);
  }
  let destroy = true;
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(
      `SELECT set_config('statement_timeout', $1, true)`,
      [`${timeoutMs}ms`],
    );
    await client.query({
      text: `SELECT EXISTS (
         SELECT 1
         FROM marketplace_published_presets AS preset
         LEFT JOIN marketplace_published_preset_revisions AS revision
           ON revision.preset_id = preset.id
          AND revision.id = preset.current_revision_id
         LIMIT 1
       ) AS marketplace_schema_ready`,
      query_timeout: timeoutMs,
    });
    await client.query('COMMIT');
    destroy = false;
  } catch (cause) {
    try { await client.query('ROLLBACK'); } catch { /* destroy the failed connection below */ }
    throw cause;
  } finally {
    client.release(destroy);
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
