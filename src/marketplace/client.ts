import type {
  MarketplaceTag,
  PublishedPreset,
  PublishPresetRequest,
} from '../../shared/marketplace';
import { parsePublicPublishedPreset } from '../../shared/marketplaceValidation';

export type MarketplaceClientErrorCode =
  | 'not_found'
  | 'unavailable'
  | 'network'
  | 'invalid_response'
  | 'authentication_required'
  | 'invalid_publication';

export class MarketplaceClientError extends Error {
  readonly code: MarketplaceClientErrorCode;
  readonly fields?: Record<string, string>;

  constructor(
    code: MarketplaceClientErrorCode,
    message: string,
    fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'MarketplaceClientError';
    this.code = code;
    this.fields = fields;
  }
}

export interface MarketplaceClient {
  getPublishedPreset(id: string): Promise<PublishedPreset>;
  listAvailableTags(): Promise<MarketplaceTag[]>;
  publishPreset(request: PublishPresetRequest): Promise<PublishedPreset>;
}

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function publicationError(response: Response): Promise<MarketplaceClientError> {
  try {
    const body = await response.json();
    if (isRecord(body) && isRecord(body.error)) {
      const error = body.error;
      const fields = isRecord(error.fields)
        ? Object.fromEntries(
            Object.entries(error.fields).filter((entry): entry is [string, string] => (
              typeof entry[1] === 'string'
            )),
          )
        : undefined;
      if (response.status === 401) {
        return new MarketplaceClientError('authentication_required', '请先登录再发布。');
      }
      if (error.code === 'invalid_publication') {
        return new MarketplaceClientError(
          'invalid_publication',
          '发布内容需要修正。',
          fields,
        );
      }
    }
  } catch {
    // Stable fallback below owns malformed error bodies.
  }
  return new MarketplaceClientError('unavailable', '音色广场暂时不可用；本地效果器仍可正常使用。');
}

function parseTag(value: unknown): MarketplaceTag | null {
  if (!isRecord(value)) return null;
  const keys = ['dimension', 'id', 'nameEn', 'nameZh'];
  if (
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys)
    || typeof value.id !== 'string'
    || typeof value.dimension !== 'string'
    || typeof value.nameZh !== 'string'
    || typeof value.nameEn !== 'string'
  ) return null;
  return value as unknown as MarketplaceTag;
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

    async listAvailableTags() {
      let response: Response;
      try {
        response = await fetchResponse('/api/marketplace/tags');
      } catch {
        throw new MarketplaceClientError('network', '无法连接音色广场；本地效果器仍可正常使用。');
      }
      if (!response.ok) throw await publicationError(response);
      const body = await response.json() as { tags?: unknown };
      if (!Array.isArray(body.tags)) {
        throw new MarketplaceClientError('invalid_response', '标签数据无法读取。');
      }
      const tags = body.tags.map(parseTag);
      if (tags.some((tag) => !tag)) {
        throw new MarketplaceClientError('invalid_response', '标签数据无法读取。');
      }
      return tags as MarketplaceTag[];
    },

    async publishPreset(request) {
      let response: Response;
      try {
        response = await fetchResponse('/api/marketplace/presets', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
        });
      } catch {
        throw new MarketplaceClientError('network', '无法连接音色广场；本地 Rig 未受影响。');
      }
      if (!response.ok) throw await publicationError(response);
      const body = await response.json() as { preset?: unknown };
      const preset = parsePublicPublishedPreset(body.preset);
      if (!preset) throw new MarketplaceClientError('invalid_response', '发布响应格式无效。');
      return preset;
    },
  };
}

export const marketplaceClient = createMarketplaceClient();
