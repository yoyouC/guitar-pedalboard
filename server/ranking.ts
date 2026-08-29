import type { MarketplaceLikeTargetKind } from '../shared/marketplace.ts';

export interface MarketplaceRankingPageInput {
  kind: MarketplaceLikeTargetKind;
  limit: number;
  cursor: string | null;
}
