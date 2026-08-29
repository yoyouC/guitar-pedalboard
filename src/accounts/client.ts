import type {
  MarketplaceAccountDeletion,
  MarketplaceAccountExport,
} from '../../shared/account.ts';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class MarketplaceAccountClientError extends Error {
  readonly code: string;
  readonly verificationUrl?: string;

  constructor(code: string, message: string, verificationUrl?: string) {
    super(message);
    this.code = code;
    this.verificationUrl = verificationUrl;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function responseError(response: Response): Promise<MarketplaceAccountClientError> {
  try {
    const body = await response.json() as {
      error?: { code?: unknown; message?: unknown; verificationUrl?: unknown };
    };
    if (typeof body.error?.code === 'string' && typeof body.error.message === 'string') {
      const verificationUrl = typeof body.error.verificationUrl === 'string'
        && body.error.verificationUrl.startsWith('/')
        && !body.error.verificationUrl.startsWith('//')
        ? body.error.verificationUrl
        : undefined;
      return new MarketplaceAccountClientError(
        body.error.code,
        body.error.message,
        verificationUrl,
      );
    }
  } catch {
    // Stable fallback below owns malformed error responses.
  }
  return new MarketplaceAccountClientError('marketplace_unavailable', '账户服务暂时不可用');
}

function parseDeletion(value: unknown): MarketplaceAccountDeletion | null {
  if (!isRecord(value)) return null;
  if (
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(['purgeAfter', 'requestedAt', 'status'])
    || value.status !== 'pending'
    || typeof value.requestedAt !== 'string'
    || typeof value.purgeAfter !== 'string'
    || !Number.isFinite(Date.parse(value.requestedAt))
    || !Number.isFinite(Date.parse(value.purgeAfter))
  ) return null;
  return value as unknown as MarketplaceAccountDeletion;
}

function parseExport(value: unknown): MarketplaceAccountExport | null {
  if (!isRecord(value) || !isRecord(value.account) || !isRecord(value.member)) return null;
  if (
    value.formatVersion !== 1
    || typeof value.exportedAt !== 'string'
    || JSON.stringify(Object.keys(value.account).sort()) !== JSON.stringify(['email'])
    || typeof value.account.email !== 'string'
    || !Array.isArray(value.presets)
    || !Array.isArray(value.collections)
    || !isRecord(value.relationships)
    || !Array.isArray(value.relationships.presetLikes)
    || !Array.isArray(value.relationships.collectionLikes)
    || !Array.isArray(value.relationships.moderationReports)
    || !Array.isArray(value.relationships.moderationAppeals)
  ) return null;
  const memberKeys = [
    'avatarUrl', 'bio', 'createdAt', 'displayName', 'handle', 'id', 'updatedAt',
  ].sort();
  if (
    JSON.stringify(Object.keys(value.member).sort()) !== JSON.stringify(memberKeys)
    || typeof value.member.id !== 'string'
    || typeof value.member.handle !== 'string'
    || typeof value.member.displayName !== 'string'
    || typeof value.member.bio !== 'string'
    || (value.member.avatarUrl !== null && typeof value.member.avatarUrl !== 'string')
    || typeof value.member.createdAt !== 'string'
    || typeof value.member.updatedAt !== 'string'
  ) return null;
  return value as unknown as MarketplaceAccountExport;
}

export async function fetchMarketplaceAccountExport(
  fetchResponse: FetchLike = globalThis.fetch,
): Promise<{ data: MarketplaceAccountExport; filename: string }> {
  const response = await fetchResponse('/api/marketplace/me/export', {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw await responseError(response);
  const data = parseExport(await response.json());
  if (!data) throw new MarketplaceAccountClientError('invalid_account_export', '账户导出响应无效');
  const disposition = response.headers.get('content-disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'guitar-pedalboard-export.json';
  return { data, filename };
}

export async function fetchMarketplaceAccountDeletion(
  fetchResponse: FetchLike = globalThis.fetch,
): Promise<MarketplaceAccountDeletion | null> {
  const response = await fetchResponse('/api/marketplace/me/deletion', {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw await responseError(response);
  const body = await response.json() as { deletion?: unknown };
  if (body.deletion === null) return null;
  const deletion = parseDeletion(body.deletion);
  if (!deletion) throw new MarketplaceAccountClientError('invalid_account_response', '账户状态响应无效');
  return deletion;
}

export async function requestMarketplaceAccountDeletion(
  fetchResponse: FetchLike = globalThis.fetch,
): Promise<MarketplaceAccountDeletion> {
  const response = await fetchResponse('/api/marketplace/me/deletion', { method: 'POST' });
  if (!response.ok) throw await responseError(response);
  const body = await response.json() as { deletion?: unknown };
  const deletion = parseDeletion(body.deletion);
  if (!deletion) throw new MarketplaceAccountClientError('invalid_account_response', '注销响应无效');
  return deletion;
}

export async function recoverMarketplaceAccount(
  fetchResponse: FetchLike = globalThis.fetch,
): Promise<void> {
  const response = await fetchResponse('/api/marketplace/me/deletion', { method: 'DELETE' });
  if (!response.ok) throw await responseError(response);
  const body = await response.json() as { recovered?: unknown };
  if (body.recovered !== true) {
    throw new MarketplaceAccountClientError('invalid_account_response', '账户恢复响应无效');
  }
}
