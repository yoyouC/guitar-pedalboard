import type {
  MarketplaceLikeState,
  MarketplaceLikeTargetKind,
  MarketplaceMyLikes,
  MarketplaceRankingPage,
} from '../../shared/marketplace.ts';
import type { MarketplaceRankingPageInput } from '../ranking.ts';

export class LikeTargetNotFoundError extends Error {}
export class SelfLikeForbiddenError extends Error {}
export class InvalidPopularCursorError extends Error {}

export interface MarketplaceLikeRepository {
  getState(
    kind: MarketplaceLikeTargetKind,
    targetId: string,
    memberId: string | null,
  ): Promise<MarketplaceLikeState>;
  setLiked(input: {
    kind: MarketplaceLikeTargetKind;
    targetId: string;
    memberId: string;
    liked: boolean;
    now: Date;
  }): Promise<MarketplaceLikeState>;
  listMine(memberId: string): Promise<MarketplaceMyLikes>;
  listPopular(input: MarketplaceRankingPageInput): Promise<MarketplaceRankingPage>;
}
