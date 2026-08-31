import type { MarketplaceLikeTargetKind } from '../shared/marketplace.js';

export interface MarketplaceRankingPageInput {
  kind: MarketplaceLikeTargetKind;
  limit: number;
  cursor: string | null;
}
