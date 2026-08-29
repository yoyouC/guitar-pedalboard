import type { PublishedPresetSearchRepository } from './repository.ts';
import type { PublishedPresetSearchInput } from './repository.ts';
import { InvalidSearchCursorError } from './cursor.ts';
import { parseRigResourceDependencyKey } from '../../shared/marketplaceResource.ts';

export interface PublishedPresetSearchApi {
  fetch(request: Request): Promise<Response>;
}

const SEARCH_PATH = '/api/marketplace/search/presets';

export function createPublishedPresetSearchApi(input: {
  presets: PublishedPresetSearchRepository;
}): PublishedPresetSearchApi {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== 'GET' || url.pathname !== SEARCH_PATH) {
        return new Response(null, { status: 404 });
      }
      const parsed = parseSearchInput(url.searchParams);
      if (!parsed) return invalidSearch('invalid_preset_search');
      try {
        const page = await input.presets.searchPublicPresets(parsed);
        return Response.json(page);
      } catch (cause) {
        if (cause instanceof InvalidSearchCursorError) return invalidSearch('invalid_search_cursor');
        return Response.json({
          error: { code: 'marketplace_unavailable', message: 'Marketplace is temporarily unavailable' },
        }, { status: 503 });
      }
    },
  };
}

const ALLOWED_PARAMETERS = new Set([
  'q', 'tag', 'pedal', 'amp', 'cab', 'resourceKind', 'resource',
  'publishedAfter', 'publishedBefore', 'limit', 'cursor',
]);

function single(params: URLSearchParams, name: string): string | null | undefined {
  const values = params.getAll(name);
  if (values.length > 1) return undefined;
  return values[0] ?? null;
}

function repeated(params: URLSearchParams, name: string): string[] | null {
  const values = params.getAll(name);
  if (values.some((value) => !value) || new Set(values).size !== values.length) return null;
  return values;
}

function parseSearchInput(params: URLSearchParams): PublishedPresetSearchInput | null {
  if ([...params.keys()].some((key) => !ALLOWED_PARAMETERS.has(key))) return null;
  const q = single(params, 'q');
  const publishedAfter = single(params, 'publishedAfter');
  const publishedBefore = single(params, 'publishedBefore');
  const limitValue = single(params, 'limit');
  const cursor = single(params, 'cursor');
  if (
    q === undefined
    || publishedAfter === undefined
    || publishedBefore === undefined
    || limitValue === undefined
    || cursor === undefined
  ) {
    return null;
  }
  if (
    (publishedAfter !== null && !Number.isFinite(Date.parse(publishedAfter)))
    || (publishedBefore !== null && !Number.isFinite(Date.parse(publishedBefore)))
    || (
      publishedAfter !== null
      && publishedBefore !== null
      && Date.parse(publishedAfter) > Date.parse(publishedBefore)
    )
  ) return null;
  const limit = limitValue === null ? 20 : Number(limitValue);
  if (
    !Number.isInteger(limit)
    || limit < 1
    || limit > 50
    || (limitValue !== null && String(limit) !== limitValue)
  ) return null;
  const tagIds = repeated(params, 'tag');
  const pedalIds = repeated(params, 'pedal');
  const ampIds = repeated(params, 'amp');
  const cabIds = repeated(params, 'cab');
  const resourceKinds = repeated(params, 'resourceKind');
  const resourceValues = repeated(params, 'resource');
  if (!tagIds || !pedalIds || !ampIds || !cabIds || !resourceKinds || !resourceValues) return null;
  if (resourceKinds.some((kind) => kind !== 'builtin' && kind !== 'tone3000')) return null;
  const resourceDependencyKeys = resourceValues.map(parseRigResourceDependencyKey);
  if (resourceDependencyKeys.some((key) => key === null)) return null;
  return {
    text: q ?? '',
    tagIds,
    pedalIds,
    ampIds,
    cabIds,
    resourceKinds: resourceKinds as PublishedPresetSearchInput['resourceKinds'],
    resourceDependencyKeys: resourceDependencyKeys as PublishedPresetSearchInput['resourceDependencyKeys'],
    publishedAfter: publishedAfter ? new Date(publishedAfter).toISOString() : null,
    publishedBefore: publishedBefore ? new Date(publishedBefore).toISOString() : null,
    limit,
    cursor: cursor || null,
  };
}

function invalidSearch(code: 'invalid_preset_search' | 'invalid_search_cursor'): Response {
  return Response.json({
    error: { code, message: 'Published preset search is invalid' },
  }, { status: 400 });
}
