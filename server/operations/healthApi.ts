export interface MarketplaceHealthApi {
  fetch(request: Request): Promise<Response>;
}

interface MarketplaceHealthQuery {
  text: string;
  values?: unknown[];
  query_timeout: number;
}

interface MarketplaceHealthClient {
  query(config: MarketplaceHealthQuery): Promise<unknown>;
  release(destroy?: boolean): void;
}

export async function probeMarketplaceStorage(
  database: {
    connect(): Promise<MarketplaceHealthClient>;
  },
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const connection = database.connect();
  let connectionTimer: ReturnType<typeof setTimeout> | undefined;
  let client: MarketplaceHealthClient;
  try {
    client = await Promise.race([
      connection,
      new Promise<never>((_resolve, reject) => {
        connectionTimer = setTimeout(
          () => reject(new Error('Marketplace storage connection timed out')),
          remainingBefore(deadline, 'Marketplace storage connection timed out'),
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
    await queryBeforeDeadline(client, { text: 'BEGIN READ ONLY' }, deadline);
    await queryBeforeDeadline(
      client,
      {
        text: `SELECT set_config('statement_timeout', $1, true)`,
        values: [`${remainingBefore(deadline)}ms`],
      },
      deadline,
    );
    await queryBeforeDeadline(client, {
      text: `SELECT EXISTS (
         SELECT 1
         FROM marketplace_published_presets AS preset
         LEFT JOIN marketplace_published_preset_revisions AS revision
           ON revision.preset_id = preset.id
          AND revision.id = preset.current_revision_id
         LIMIT 1
       ) AS marketplace_schema_ready`,
    }, deadline);
    await queryBeforeDeadline(client, { text: 'COMMIT' }, deadline);
    destroy = false;
  } finally {
    client.release(destroy);
  }
}

function remainingBefore(
  deadline: number,
  message = 'Marketplace storage probe timed out',
): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(message);
  return remaining;
}

async function queryBeforeDeadline(
  client: MarketplaceHealthClient,
  config: Omit<MarketplaceHealthQuery, 'query_timeout'>,
  deadline: number,
): Promise<void> {
  const remaining = remainingBefore(deadline);
  const query = client.query({ ...config, query_timeout: remaining });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      query,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Marketplace storage probe timed out')),
          remaining,
        );
      }),
    ]);
  } catch (cause) {
    void query.catch(() => undefined);
    throw cause;
  } finally {
    if (timer) clearTimeout(timer);
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
