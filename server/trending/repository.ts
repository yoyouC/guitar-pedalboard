import type { MarketplaceRankingPage } from '../../shared/marketplace.ts';
import type { MarketplaceRankingPageInput } from '../ranking.ts';
import type { MarketplaceTrendingPolicy } from './policy.ts';

export class InvalidTrendingCursorError extends Error {}

export interface MarketplaceTrendingRepository {
  list(input: MarketplaceRankingPageInput): Promise<MarketplaceRankingPage>;
  rebuild(input: { now: Date; policy: MarketplaceTrendingPolicy }): Promise<void>;
}
