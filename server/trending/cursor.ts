import type { MarketplaceLikeTargetKind } from '../../shared/marketplace.ts';
import { InvalidTrendingCursorError } from './repository.ts';

export interface TrendingBoundary { trendScore: number; id: string }
export interface TrendingCursorState extends TrendingBoundary { snapshotVersion: number }

export function encodeTrendingCursor(
  kind: MarketplaceLikeTargetKind,
  limit: number,
  snapshotVersion: number,
  after: TrendingBoundary,
): string {
  return Buffer.from(JSON.stringify({
    version: 1, kind, limit, snapshotVersion, trendScore: after.trendScore, id: after.id,
  })).toString('base64url');
}

export function decodeTrendingCursor(
  encoded: string,
  kind: MarketplaceLikeTargetKind,
  limit: number,
): TrendingCursorState {
  try {
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      Object.keys(value).length !== 6 || value.version !== 1 || value.kind !== kind
      || value.limit !== limit || typeof value.trendScore !== 'number'
      || !Number.isFinite(value.trendScore) || value.trendScore <= 0
      || !Number.isInteger(value.snapshotVersion) || Number(value.snapshotVersion) < 1
      || typeof value.id !== 'string' || !value.id
    ) throw new InvalidTrendingCursorError();
    return {
      snapshotVersion: Number(value.snapshotVersion),
      trendScore: value.trendScore,
      id: value.id,
    };
  } catch (cause) {
    if (cause instanceof InvalidTrendingCursorError) throw cause;
    throw new InvalidTrendingCursorError();
  }
}

export function followsTrendingBoundary(
  value: TrendingBoundary,
  after: TrendingBoundary,
): boolean {
  return value.trendScore < after.trendScore
    || (value.trendScore === after.trendScore && value.id < after.id);
}
