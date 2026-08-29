import type { PublishedPreset } from '../../shared/marketplace';
import { parsePublicPublishedPreset } from '../../shared/marketplaceValidation';

export type MarketplaceClientErrorCode =
  | 'not_found'
  | 'unavailable'
  | 'network'
  | 'invalid_response';

export class MarketplaceClientError extends Error {
  readonly code: MarketplaceClientErrorCode;

  constructor(
    code: MarketplaceClientErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MarketplaceClientError';
    this.code = code;
  }
}

export interface MarketplaceClient {
  getPublishedPreset(id: string): Promise<PublishedPreset>;
}

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createMarketplaceClient(fetchResponse: Fetch = fetch): MarketplaceClient {
  return {
    async getPublishedPreset(id) {
      let response: Response;
      try {
        response = await fetchResponse(
          `/api/marketplace/presets/${encodeURIComponent(id)}`,
        );
      } catch {
        throw new MarketplaceClientError(
          'network',
          '无法连接音色广场；本地效果器仍可正常使用。',
        );
      }

      if (response.status === 404) {
        throw new MarketplaceClientError('not_found', '找不到这个公开音色。');
      }
      if (!response.ok) {
        throw new MarketplaceClientError(
          'unavailable',
          '音色广场暂时不可用；本地效果器仍可正常使用。',
        );
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new MarketplaceClientError('invalid_response', '音色数据无法读取，请稍后重试。');
      }
      const preset = isRecord(body) ? parsePublicPublishedPreset(body.preset, id) : null;
      if (!preset) {
        throw new MarketplaceClientError('invalid_response', '音色数据格式不兼容，请升级应用。');
      }
      return preset;
    },
  };
}

export const marketplaceClient = createMarketplaceClient();
