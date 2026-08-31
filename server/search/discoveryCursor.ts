import { normalizeSearchText } from './text.js';
import {
  decodeStableSearchCursor,
  encodeStableSearchCursor,
  type SearchBoundary,
  type StableSearchCursor,
} from './cursor.js';
import type { MarketplaceDiscoverySearchInput } from './repository.js';

export type MarketplaceDiscoveryKind = 'collections' | 'creators';

function fingerprint(kind: MarketplaceDiscoveryKind, input: MarketplaceDiscoverySearchInput): string {
  return JSON.stringify({ kind, text: normalizeSearchText(input.text), limit: input.limit });
}

export function encodeDiscoveryCursor(
  kind: MarketplaceDiscoveryKind,
  input: MarketplaceDiscoverySearchInput,
  snapshot: SearchBoundary,
  after: SearchBoundary,
): string {
  return encodeStableSearchCursor(fingerprint(kind, input), snapshot, after);
}

export function decodeDiscoveryCursor(
  kind: MarketplaceDiscoveryKind,
  input: MarketplaceDiscoverySearchInput,
): StableSearchCursor | null {
  if (!input.cursor) return null;
  return decodeStableSearchCursor(input.cursor, fingerprint(kind, input));
}
