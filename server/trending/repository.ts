import type { MarketplaceRankingPage } from '../../shared/marketplace.js';
import type { MarketplaceRankingPageInput } from '../ranking.js';
import type { MarketplaceTrendingPolicy } from './policy.js';

export class InvalidTrendingCursorError extends Error {}

export interface MarketplaceTrendingRepository {
  list(input: MarketplaceRankingPageInput): Promise<MarketplaceRankingPage>;
  rebuild(input: { now: Date; policy: MarketplaceTrendingPolicy }): Promise<void>;
}
