import type { MarketplaceLikeTargetKind } from '../../shared/marketplace.ts';
import { InvalidPopularCursorError } from './repository.ts';

export interface PopularBoundary { likeCount: number; id: string }
export interface PopularCursorState extends PopularBoundary { snapshotVersion: number }

export function encodePopularCursor(
  kind: MarketplaceLikeTargetKind,
  limit: number,
  snapshotVersion: number,
  after: PopularBoundary,
): string {
  return Buffer.from(JSON.stringify({
    version: 1, kind, limit, snapshotVersion, likeCount: after.likeCount, id: after.id,
  })).toString('base64url');
}

export function decodePopularCursor(
  encoded: string,
  kind: MarketplaceLikeTargetKind,
  limit: number,
): PopularCursorState {
  try {
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      Object.keys(value).length !== 6 || value.version !== 1 || value.kind !== kind
      || value.limit !== limit || !Number.isInteger(value.likeCount) || Number(value.likeCount) < 0
      || !Number.isInteger(value.snapshotVersion) || Number(value.snapshotVersion) < 0
      || typeof value.id !== 'string' || !value.id
    ) throw new InvalidPopularCursorError();
    return {
      snapshotVersion: Number(value.snapshotVersion),
      likeCount: Number(value.likeCount),
      id: value.id,
    };
  } catch (cause) {
    if (cause instanceof InvalidPopularCursorError) throw cause;
    throw new InvalidPopularCursorError();
  }
}

export function followsPopularBoundary(value: PopularBoundary, after: PopularBoundary): boolean {
  return value.likeCount < after.likeCount
    || (value.likeCount === after.likeCount && value.id < after.id);
}
