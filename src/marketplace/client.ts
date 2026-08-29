import type {
  AppendPublishedPresetRevisionRequest,
  CreatePresetCollectionRequest,
  MarketplaceTag,
  MarketplaceLikeState,
  MarketplaceLikeTargetKind,
  MarketplaceMyLikes,
  MarketplacePopularPage,
  PresetCollection,
  PresetCollectionConcurrencyState,
  PublishedPresetSearchPage,
  PublishedPresetSearchRequest,
  PublishedPreset,
  PublishedPresetConcurrencyState,
  PublishedPresetRevisionSummary,
  PublishedPresetRevisionView,
  PublishPresetRequest,
  RestorePublishedPresetRevisionRequest,
  UpdatePublishedPresetMetadataRequest,
  UpdatePublishedPresetVisibilityRequest,
  UpdatePresetCollectionRequest,
} from '../../shared/marketplace';
import {
  parseManagedPublishedPreset,
  parseMarketplaceLikeState,
  parseMarketplaceMyLikes,
  parseMarketplacePopularPage,
  parsePresetCollection,
  parsePublishedPresetSearchPage,
  parsePublicPublishedPreset,
  parsePublishedPresetRevisionView,
} from '../../shared/marketplaceValidation';

export type MarketplaceClientErrorCode =
  | 'not_found'
  | 'unavailable'
  | 'network'
  | 'invalid_response'
  | 'authentication_required'
  | 'invalid_publication'
  | 'invalid_update'
  | 'invalid_search'
  | 'forbidden'
  | 'update_conflict';

export class MarketplaceClientError extends Error {
  readonly code: MarketplaceClientErrorCode;
  readonly fields?: Record<string, string>;
  readonly current?: PublishedPresetConcurrencyState;
  readonly collectionCurrent?: PresetCollectionConcurrencyState;

  constructor(
    code: MarketplaceClientErrorCode,
    message: string,
    fields?: Record<string, string>,
    current?: PublishedPresetConcurrencyState,
    collectionCurrent?: PresetCollectionConcurrencyState,
  ) {
    super(message);
    this.name = 'MarketplaceClientError';
    this.code = code;
    this.fields = fields;
    this.current = current;
    this.collectionCurrent = collectionCurrent;
  }
}

export interface MarketplaceClient {
  getPublishedPreset(id: string): Promise<PublishedPreset>;
  listAvailableTags(): Promise<MarketplaceTag[]>;
  publishPreset(request: PublishPresetRequest): Promise<PublishedPreset>;
  getManagedPublishedPreset(id: string): Promise<PublishedPreset>;
  getPublishedPresetRevision(id: string, revisionId: string): Promise<PublishedPresetRevisionView>;
  listPublishedPresetRevisions(id: string): Promise<PublishedPresetRevisionSummary[]>;
  updatePublishedPresetMetadata(
    id: string,
    request: UpdatePublishedPresetMetadataRequest,
  ): Promise<PublishedPreset>;
  appendPublishedPresetRevision(
    id: string,
    request: AppendPublishedPresetRevisionRequest,
  ): Promise<PublishedPreset>;
  restorePublishedPresetRevision(
    id: string,
    revisionId: string,
    request: RestorePublishedPresetRevisionRequest,
  ): Promise<PublishedPreset>;
  updatePublishedPresetVisibility(
    id: string,
    request: UpdatePublishedPresetVisibilityRequest,
  ): Promise<PublishedPreset>;
  getPresetCollection(id: string): Promise<PresetCollection>;
  getManagedPresetCollection(id: string): Promise<PresetCollection>;
  createPresetCollection(request: CreatePresetCollectionRequest): Promise<PresetCollection>;
  updatePresetCollection(
    id: string,
    request: UpdatePresetCollectionRequest,
  ): Promise<PresetCollection>;
  searchPublishedPresets(request: PublishedPresetSearchRequest): Promise<PublishedPresetSearchPage>;
  getLikeState(kind: MarketplaceLikeTargetKind, id: string): Promise<MarketplaceLikeState>;
  setLike(kind: MarketplaceLikeTargetKind, id: string, liked: boolean): Promise<MarketplaceLikeState>;
  getMyLikes(): Promise<MarketplaceMyLikes>;
  listPopular(
    kind: MarketplaceLikeTargetKind,
    request?: { limit?: number; cursor?: string },
  ): Promise<MarketplacePopularPage>;
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
      if (error.code === 'self_like_forbidden') {
        return new MarketplaceClientError('forbidden', '不能给自己的作品点赞。');
      }
      if (error.code === 'like_target_not_found') {
        return new MarketplaceClientError('not_found', '点赞目标当前不可访问。');
      }
      if (error.code === 'invalid_publication') {
        return new MarketplaceClientError(
          'invalid_publication',
          '发布内容需要修正。',
          fields,
        );
      }
      if (error.code === 'invalid_preset_update') {
        return new MarketplaceClientError('invalid_update', '修改内容需要修正。', fields);
      }
      if (error.code === 'invalid_collection') {
        return new MarketplaceClientError('invalid_update', '合集内容需要修正。', fields);
      }
      if (error.code === 'invalid_collection_reference') {
        return new MarketplaceClientError(
          'invalid_update',
          '合集包含不可访问的音色修订。',
          { items: '请选择允许收录的固定修订' },
        );
      }
      if (error.code === 'invalid_preset_search' || error.code === 'invalid_search_cursor') {
        return new MarketplaceClientError(
          'invalid_search',
          error.code === 'invalid_search_cursor'
            ? '搜索结果已变化，请从第一页重新搜索。'
            : '搜索条件无效。',
        );
      }
      if (error.code === 'collection_update_conflict' && isRecord(error.current)) {
        const current = error.current;
        if (
          typeof current.updatedAt === 'string'
          && ['public', 'unlisted', 'withdrawn', 'hidden'].includes(String(current.visibility))
        ) {
          return new MarketplaceClientError(
            'update_conflict',
            '合集已在别处更新，请重新载入后再试。',
            fields,
            undefined,
            current as unknown as PresetCollectionConcurrencyState,
          );
        }
      }
      if (error.code === 'preset_update_conflict' && isRecord(error.current)) {
        const current = error.current;
        if (
          typeof current.updatedAt === 'string'
          && typeof current.currentRevisionId === 'string'
          && ['public', 'unlisted', 'withdrawn', 'hidden'].includes(String(current.visibility))
        ) {
          return new MarketplaceClientError(
            'update_conflict',
            '作品已在别处更新，请重新载入后再试。',
            fields,
            current as unknown as PublishedPresetConcurrencyState,
          );
        }
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

function parseRevisionSummary(value: unknown): PublishedPresetRevisionSummary | null {
  if (!isRecord(value)) return null;
  if (
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(['createdAt', 'id', 'isCurrent'])
    || typeof value.id !== 'string'
    || typeof value.createdAt !== 'string'
    || typeof value.isCurrent !== 'boolean'
  ) return null;
  return value as unknown as PublishedPresetRevisionSummary;
}

async function managedMutation(
  fetchResponse: Fetch,
  path: string,
  method: 'PATCH' | 'POST',
  request: unknown,
): Promise<PublishedPreset> {
  let response: Response;
  try {
    response = await fetchResponse(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch {
    throw new MarketplaceClientError('network', '无法连接音色广场；本地 Rig 未受影响。');
  }
  if (!response.ok) throw await publicationError(response);
  const body = await response.json() as { preset?: unknown };
  const preset = parseManagedPublishedPreset(body.preset);
  if (!preset) throw new MarketplaceClientError('invalid_response', '作品管理响应无效。');
  return preset;
}

async function collectionMutation(
  fetchResponse: Fetch,
  path: string,
  method: 'PATCH' | 'POST',
  request: unknown,
): Promise<PresetCollection> {
  let response: Response;
  try {
    response = await fetchResponse(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch {
    throw new MarketplaceClientError('network', '无法连接音色广场。');
  }
  if (!response.ok) throw await publicationError(response);
  const body = await response.json() as { collection?: unknown };
  const collection = parsePresetCollection(body.collection, undefined, true);
  if (!collection) throw new MarketplaceClientError('invalid_response', '合集响应格式无效。');
  return collection;
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

    async getPublishedPresetRevision(id, revisionId) {
      let response: Response;
      try {
        response = await fetchResponse(
          `/api/marketplace/presets/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}`,
        );
      } catch {
        throw new MarketplaceClientError('network', '无法连接音色广场；本地效果器仍可正常使用。');
      }
      if (response.status === 404) {
        throw new MarketplaceClientError('not_found', '找不到这个音色修订。');
      }
      if (!response.ok) throw await publicationError(response);
      const body = await response.json() as { preset?: unknown };
      const preset = parsePublishedPresetRevisionView(body.preset, id, revisionId);
      if (!preset) throw new MarketplaceClientError('invalid_response', '音色修订响应无效。');
      return preset;
    },

    async getManagedPublishedPreset(id) {
      let response: Response;
      try {
        response = await fetchResponse(
          `/api/marketplace/presets/${encodeURIComponent(id)}/manage`,
        );
      } catch {
        throw new MarketplaceClientError('network', '无法连接音色广场。');
      }
      if (response.status === 404) {
        throw new MarketplaceClientError('not_found', '找不到可管理的作品。');
      }
      if (!response.ok) throw await publicationError(response);
      const body = await response.json() as { preset?: unknown };
      const preset = parseManagedPublishedPreset(body.preset, id);
      if (!preset) throw new MarketplaceClientError('invalid_response', '作品管理响应无效。');
      return preset;
    },

    async listPublishedPresetRevisions(id) {
      let response: Response;
      try {
        response = await fetchResponse(
          `/api/marketplace/presets/${encodeURIComponent(id)}/revisions`,
        );
      } catch {
        throw new MarketplaceClientError('network', '无法连接音色广场。');
      }
      if (!response.ok) throw await publicationError(response);
      const body = await response.json() as { revisions?: unknown };
      if (!Array.isArray(body.revisions)) {
        throw new MarketplaceClientError('invalid_response', '修订历史响应无效。');
      }
      const revisions = body.revisions.map(parseRevisionSummary);
      if (revisions.some((revision) => !revision)) {
        throw new MarketplaceClientError('invalid_response', '修订历史响应无效。');
      }
      return revisions as PublishedPresetRevisionSummary[];
    },

    updatePublishedPresetMetadata(id, request) {
      return managedMutation(
        fetchResponse,
        `/api/marketplace/presets/${encodeURIComponent(id)}/metadata`,
        'PATCH',
        request,
      );
    },

    appendPublishedPresetRevision(id, request) {
      return managedMutation(
        fetchResponse,
        `/api/marketplace/presets/${encodeURIComponent(id)}/revisions`,
        'POST',
        request,
      );
    },

    restorePublishedPresetRevision(id, revisionId, request) {
      return managedMutation(
        fetchResponse,
        `/api/marketplace/presets/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}/restore`,
        'POST',
        request,
      );
    },

    updatePublishedPresetVisibility(id, request) {
      return managedMutation(
        fetchResponse,
        `/api/marketplace/presets/${encodeURIComponent(id)}/visibility`,
        'PATCH',
        request,
      );
    },

    async getPresetCollection(id) {
      let response: Response;
      try {
        response = await fetchResponse(
          `/api/marketplace/collections/${encodeURIComponent(id)}`,
        );
      } catch {
        throw new MarketplaceClientError('network', '无法连接音色广场。');
      }
      if (response.status === 404) {
        throw new MarketplaceClientError('not_found', '找不到这个预设合集。');
      }
      if (!response.ok) throw await publicationError(response);
      const body = await response.json() as { collection?: unknown };
      const collection = parsePresetCollection(body.collection, id);
      if (!collection) throw new MarketplaceClientError('invalid_response', '合集响应格式无效。');
      return collection;
    },

    async getManagedPresetCollection(id) {
      let response: Response;
      try {
        response = await fetchResponse(
          `/api/marketplace/collections/${encodeURIComponent(id)}/manage`,
        );
      } catch {
        throw new MarketplaceClientError('network', '无法连接音色广场。');
      }
      if (response.status === 404) {
        throw new MarketplaceClientError('not_found', '找不到可管理的合集。');
      }
      if (!response.ok) throw await publicationError(response);
      const body = await response.json() as { collection?: unknown };
      const collection = parsePresetCollection(body.collection, id, true);
      if (!collection) throw new MarketplaceClientError('invalid_response', '合集管理响应无效。');
      return collection;
    },

    createPresetCollection(request) {
      return collectionMutation(fetchResponse, '/api/marketplace/collections', 'POST', request);
    },

    updatePresetCollection(id, request) {
      return collectionMutation(
        fetchResponse,
        `/api/marketplace/collections/${encodeURIComponent(id)}`,
        'PATCH',
        request,
      );
    },

    async searchPublishedPresets(request) {
      const params = new URLSearchParams();
      if (request.text) params.set('q', request.text);
      for (const tagId of request.tagIds ?? []) params.append('tag', tagId);
      for (const pedalId of request.pedalIds ?? []) params.append('pedal', pedalId);
      for (const ampId of request.ampIds ?? []) params.append('amp', ampId);
      for (const cabId of request.cabIds ?? []) params.append('cab', cabId);
      for (const kind of request.resourceKinds ?? []) params.append('resourceKind', kind);
      for (const key of request.resourceDependencyKeys ?? []) params.append('resource', key);
      if (request.publishedAfter) params.set('publishedAfter', request.publishedAfter);
      if (request.publishedBefore) params.set('publishedBefore', request.publishedBefore);
      if (request.limit !== undefined) params.set('limit', String(request.limit));
      if (request.cursor) params.set('cursor', request.cursor);
      let response: Response;
      try {
        response = await fetchResponse(`/api/marketplace/search/presets?${params}`);
      } catch {
        throw new MarketplaceClientError('network', '无法连接音色广场。');
      }
      if (!response.ok) throw await publicationError(response);
      const page = parsePublishedPresetSearchPage(await response.json());
      if (!page) throw new MarketplaceClientError('invalid_response', '搜索结果格式无效。');
      return page;
    },

    async getLikeState(kind, id) {
      return likeStateRequest(fetchResponse, kind, id, 'GET');
    },

    async setLike(kind, id, liked) {
      return likeStateRequest(fetchResponse, kind, id, liked ? 'PUT' : 'DELETE');
    },

    async getMyLikes() {
      const response = await fetchResponse('/api/marketplace/me/likes').catch(() => null);
      if (!response) throw new MarketplaceClientError('network', '无法连接音色广场。');
      if (!response.ok) throw await publicationError(response);
      const body = await response.json() as { likes?: unknown };
      const likes = parseMarketplaceMyLikes(body.likes);
      if (!likes) throw new MarketplaceClientError('invalid_response', '点赞列表格式无效。');
      return likes;
    },

    async listPopular(kind, request = {}) {
      const params = new URLSearchParams();
      if (request.limit !== undefined) params.set('limit', String(request.limit));
      if (request.cursor) params.set('cursor', request.cursor);
      const response = await fetchResponse(
        `/api/marketplace/popular/${likeTargetSegment(kind)}?${params}`,
      ).catch(() => null);
      if (!response) throw new MarketplaceClientError('network', '无法连接音色广场。');
      if (!response.ok) throw await publicationError(response);
      const page = parseMarketplacePopularPage(await response.json());
      if (!page) throw new MarketplaceClientError('invalid_response', '热门列表格式无效。');
      return page;
    },
  };
}

async function likeStateRequest(
  fetchResponse: Fetch,
  kind: MarketplaceLikeTargetKind,
  id: string,
  method: 'GET' | 'PUT' | 'DELETE',
): Promise<MarketplaceLikeState> {
  const response = await fetchResponse(
    `/api/marketplace/likes/${likeTargetSegment(kind)}/${encodeURIComponent(id)}`,
    { method },
  ).catch(() => null);
  if (!response) throw new MarketplaceClientError('network', '无法连接音色广场。');
  if (!response.ok) throw await publicationError(response);
  const body = await response.json() as { state?: unknown };
  const state = parseMarketplaceLikeState(body.state);
  if (!state) throw new MarketplaceClientError('invalid_response', '点赞状态格式无效。');
  return state;
}

function likeTargetSegment(kind: MarketplaceLikeTargetKind): 'presets' | 'collections' {
  return kind === 'preset' ? 'presets' : 'collections';
}

export const marketplaceClient = createMarketplaceClient();
