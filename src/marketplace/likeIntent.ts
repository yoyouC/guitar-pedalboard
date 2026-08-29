import type { MarketplaceLikeTargetKind } from '../../shared/marketplace.ts';

const STORAGE_KEY = 'guitar-pedalboard.marketplace.pending-like.v1';

export interface PendingMarketplaceLike {
  kind: MarketplaceLikeTargetKind;
  targetId: string;
}

export function rememberPendingMarketplaceLike(
  storage: Pick<Storage, 'setItem'>,
  pending: PendingMarketplaceLike,
): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(pending));
}

export function readPendingMarketplaceLike(
  storage: Pick<Storage, 'getItem'>,
): PendingMarketplaceLike | null {
  try {
    const value = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null') as unknown;
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if ((record.kind !== 'preset' && record.kind !== 'collection') || typeof record.targetId !== 'string' || !record.targetId) {
      return null;
    }
    return { kind: record.kind, targetId: record.targetId };
  } catch {
    return null;
  }
}

export function clearPendingMarketplaceLike(storage: Pick<Storage, 'removeItem'>): void {
  storage.removeItem(STORAGE_KEY);
}
