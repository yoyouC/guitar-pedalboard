import type { MarketplaceLikeTargetKind } from '../../shared/marketplace.js';

export interface ActiveMarketplaceLike {
  kind: MarketplaceLikeTargetKind;
  targetId: string;
  memberId: string;
  likedAt: Date;
}

export interface MarketplaceLikeFactSource {
  listActiveLikes(): Promise<ActiveMarketplaceLike[]>;
}
