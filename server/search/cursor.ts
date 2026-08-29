import type { PublishedPresetSearchInput } from './repository.ts';
import { normalizeSearchText } from './text.ts';

export interface SearchBoundary {
  createdAt: string;
  id: string;
}

interface SearchCursor {
  version: 1;
  fingerprint: string;
  snapshot: SearchBoundary;
  after: SearchBoundary;
}

export class InvalidSearchCursorError extends Error {}

export function searchFingerprint(input: PublishedPresetSearchInput): string {
  const sorted = (values: readonly string[]) => [...new Set(values)].sort();
  return JSON.stringify({
    text: normalizeSearchText(input.text),
    tagIds: sorted(input.tagIds),
    pedalIds: sorted(input.pedalIds),
    ampIds: sorted(input.ampIds),
    cabIds: sorted(input.cabIds),
    resourceKinds: sorted(input.resourceKinds),
    resourceDependencyKeys: sorted(input.resourceDependencyKeys),
    publishedAfter: input.publishedAfter,
    publishedBefore: input.publishedBefore,
    limit: input.limit,
  });
}

function isBoundary(value: unknown): value is SearchBoundary {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).length === 2
    && typeof candidate.createdAt === 'string'
    && Number.isFinite(Date.parse(candidate.createdAt))
    && typeof candidate.id === 'string'
    && candidate.id.length > 0;
}

export function encodeSearchCursor(
  input: PublishedPresetSearchInput,
  snapshot: SearchBoundary,
  after: SearchBoundary,
): string {
  const cursor: SearchCursor = {
    version: 1,
    fingerprint: searchFingerprint(input),
    snapshot,
    after,
  };
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeSearchCursor(
  encoded: string,
  input: PublishedPresetSearchInput,
): SearchCursor {
  try {
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      Object.keys(value).length !== 4
      || value.version !== 1
      || value.fingerprint !== searchFingerprint(input)
      || !isBoundary(value.snapshot)
      || !isBoundary(value.after)
    ) throw new InvalidSearchCursorError();
    return value as unknown as SearchCursor;
  } catch (cause) {
    if (cause instanceof InvalidSearchCursorError) throw cause;
    throw new InvalidSearchCursorError();
  }
}

export function isAtOrBefore(value: SearchBoundary, boundary: SearchBoundary): boolean {
  return value.createdAt < boundary.createdAt
    || (value.createdAt === boundary.createdAt && value.id <= boundary.id);
}

export function isAfterCursor(value: SearchBoundary, after: SearchBoundary): boolean {
  return value.createdAt < after.createdAt
    || (value.createdAt === after.createdAt && value.id < after.id);
}
