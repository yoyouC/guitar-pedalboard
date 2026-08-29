import { normalizeSearchText } from './text.ts';
import { InvalidSearchCursorError, type SearchBoundary } from './cursor.ts';
import type { MarketplaceDiscoverySearchInput } from './repository.ts';

export type MarketplaceDiscoveryKind = 'collections' | 'creators';

interface DiscoveryCursor {
  version: 1;
  fingerprint: string;
  snapshot: SearchBoundary;
  after: SearchBoundary;
}

function fingerprint(kind: MarketplaceDiscoveryKind, input: MarketplaceDiscoverySearchInput): string {
  return JSON.stringify({ kind, text: normalizeSearchText(input.text), limit: input.limit });
}

function boundary(value: unknown): value is SearchBoundary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).length === 2
    && typeof candidate.id === 'string'
    && candidate.id.length > 0
    && typeof candidate.createdAt === 'string'
    && Number.isFinite(Date.parse(candidate.createdAt));
}

export function encodeDiscoveryCursor(
  kind: MarketplaceDiscoveryKind,
  input: MarketplaceDiscoverySearchInput,
  snapshot: SearchBoundary,
  after: SearchBoundary,
): string {
  return Buffer.from(JSON.stringify({
    version: 1,
    fingerprint: fingerprint(kind, input),
    snapshot,
    after,
  } satisfies DiscoveryCursor)).toString('base64url');
}

export function decodeDiscoveryCursor(
  kind: MarketplaceDiscoveryKind,
  input: MarketplaceDiscoverySearchInput,
): DiscoveryCursor | null {
  if (!input.cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      Object.keys(value).length !== 4
      || value.version !== 1
      || value.fingerprint !== fingerprint(kind, input)
      || !boundary(value.snapshot)
      || !boundary(value.after)
    ) throw new InvalidSearchCursorError();
    return value as unknown as DiscoveryCursor;
  } catch (cause) {
    if (cause instanceof InvalidSearchCursorError) throw cause;
    throw new InvalidSearchCursorError();
  }
}
