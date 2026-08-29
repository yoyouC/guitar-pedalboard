import type { MarketplaceLikeTargetKind } from '../../shared/marketplace.ts';

export interface ActiveMarketplaceLike {
  kind: MarketplaceLikeTargetKind;
  targetId: string;
  memberId: string;
  likedAt: Date;
}

export interface MarketplaceLikeFactSource {
  listActiveLikes(): Promise<ActiveMarketplaceLike[]>;
}
