import type {
  PublishedPresetSearchRequest,
  RigDerivedAttributes,
  RigResourceDependencyKey,
} from '../../shared/marketplace';
import { parseRigResourceDependencyKey } from '../../shared/marketplaceResource';

const LIMIT = 12;

export interface MarketplaceSearchRouteState {
  request: PublishedPresetSearchRequest;
  error: string | null;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function timestamp(value: string | null): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function marketplaceSearchRouteState(search: string): MarketplaceSearchRouteState {
  const params = new URLSearchParams(search);
  const dependencies = unique(params.getAll('resource'));
  const parsedDependencies = dependencies.map(parseRigResourceDependencyKey);
  const publishedAfter = timestamp(params.get('publishedAfter'));
  const publishedBefore = timestamp(params.get('publishedBefore'));
  const invalidDate = (params.has('publishedAfter') && !publishedAfter)
    || (params.has('publishedBefore') && !publishedBefore);
  const invalidResource = parsedDependencies.some((value) => value === null);
  const allowedKinds = unique(params.getAll('resourceKind'))
    .filter((kind): kind is RigDerivedAttributes['resourceKinds'][number] => (
      kind === 'builtin' || kind === 'tone3000'
    ));
  return {
    request: {
      text: params.get('q')?.trim() || undefined,
      tagIds: unique(params.getAll('tag')),
      pedalIds: unique(params.getAll('pedal')),
      ampIds: unique(params.getAll('amp')),
      cabIds: unique(params.getAll('cab')),
      resourceKinds: allowedKinds,
      resourceDependencyKeys: parsedDependencies.filter(
        (value): value is RigResourceDependencyKey => value !== null,
      ),
      publishedAfter,
      publishedBefore,
      cursor: params.get('cursor') || undefined,
      limit: LIMIT,
    },
    error: invalidResource
      ? '资源依赖链接无效。请移除错误条件后重试。'
      : invalidDate
        ? '发布时间条件无效。请重新选择日期。'
        : null,
  };
}

function appendAll(params: URLSearchParams, name: string, values?: string[]): void {
  unique(values ?? []).forEach((value) => params.append(name, value));
}

export function marketplaceSearchPath(request: PublishedPresetSearchRequest): string {
  const params = new URLSearchParams();
  if (request.text?.trim()) params.set('q', request.text.trim());
  appendAll(params, 'tag', request.tagIds);
  appendAll(params, 'pedal', request.pedalIds);
  appendAll(params, 'amp', request.ampIds);
  appendAll(params, 'cab', request.cabIds);
  appendAll(params, 'resourceKind', request.resourceKinds);
  appendAll(params, 'resource', request.resourceDependencyKeys);
  if (request.publishedAfter) params.set('publishedAfter', request.publishedAfter);
  if (request.publishedBefore) params.set('publishedBefore', request.publishedBefore);
  if (request.cursor) params.set('cursor', request.cursor);
  const query = params.toString();
  return query ? `/marketplace?${query}` : '/marketplace';
}
