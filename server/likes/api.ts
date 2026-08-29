import type { SessionVerifier } from '../auth/session.ts';
import type { MemberRepository } from '../members/repository.ts';
import {
  communityWriteDenied,
  communityWriteErrorResponse,
} from '../members/communityWriteApi.ts';
import { marketplaceWriteLimitDenied, type MarketplaceWriteLimiter } from '../abuse/writeLimiter.ts';
import type { MarketplaceLikeTargetKind } from '../../shared/marketplace.ts';
import {
  InvalidTrendingCursorError,
  type MarketplaceTrendingRepository,
} from '../trending/repository.ts';
import {
  InvalidPopularCursorError,
  LikeTargetNotFoundError,
  SelfLikeForbiddenError,
  type MarketplaceLikeRepository,
} from './repository.ts';

const LIKE_PATH = /^\/api\/marketplace\/likes\/(presets|collections)\/([^/]+)$/;
const RANKING_PATH = /^\/api\/marketplace\/(popular|trending)\/(presets|collections)$/;
const MY_LIKES_PATH = '/api/marketplace/me/likes';
const TARGET_KIND_BY_SEGMENT: Record<'presets' | 'collections', MarketplaceLikeTargetKind> = {
  presets: 'preset',
  collections: 'collection',
};

function targetKind(segment: string): MarketplaceLikeTargetKind {
  return TARGET_KIND_BY_SEGMENT[segment as keyof typeof TARGET_KIND_BY_SEGMENT];
}

export interface MarketplaceLikesApi {
  fetch(request: Request): Promise<Response>;
}

export function createMarketplaceLikesApi(input: {
  repository: MarketplaceLikeRepository;
  trending: MarketplaceTrendingRepository;
  sessions: SessionVerifier;
  members: MemberRepository;
  now(): Date;
  createMemberId(): string;
  createHandleSuffix(): string;
  writeLimiter?: MarketplaceWriteLimiter;
}): MarketplaceLikesApi {
  const memberId = async (
    request: Request,
    now: Date,
    requireWrite = false,
  ): Promise<string | null | Response> => {
    const identity = await input.sessions.verify(request);
    if (!identity) return null;
    const member = await input.members.findOrCreateForIdentity({
      id: input.createMemberId(), identity,
      handle: `player-${input.createHandleSuffix()}`, now,
    });
    if (requireWrite) {
      const denied = communityWriteDenied(member);
      if (denied) return denied;
    }
    return member.id;
  };

  return {
    async fetch(request) {
      const url = new URL(request.url);
      const likeMatch = LIKE_PATH.exec(url.pathname);
      const rankingMatch = RANKING_PATH.exec(url.pathname);
      try {
        if (likeMatch && ['GET', 'PUT', 'DELETE'].includes(request.method)) {
          const now = input.now();
          const kind = targetKind(likeMatch[1]);
          const targetId = decodeURIComponent(likeMatch[2]);
          const currentMemberId = await memberId(request, now, request.method !== 'GET');
          if (currentMemberId instanceof Response) return currentMemberId;
          if (request.method === 'GET') {
            return Response.json({
              state: await input.repository.getState(kind, targetId, currentMemberId),
            });
          }
          if (!currentMemberId) return error(401, 'authentication_required', 'Authentication required');
          if ((await request.text()).trim()) {
            return error(400, 'invalid_like', 'Like requests do not accept a body');
          }
          const limited = await marketplaceWriteLimitDenied({
            limiter: input.writeLimiter, operation: 'like', memberId: currentMemberId,
            request, now,
          });
          if (limited) return limited;
          return Response.json({
            state: await input.repository.setLiked({
              kind, targetId, memberId: currentMemberId,
              liked: request.method === 'PUT', now,
            }),
          });
        }
        if (request.method === 'GET' && url.pathname === MY_LIKES_PATH) {
          const currentMemberId = await memberId(request, input.now());
          if (currentMemberId instanceof Response) return currentMemberId;
          if (!currentMemberId) return error(401, 'authentication_required', 'Authentication required');
          return Response.json({ likes: await input.repository.listMine(currentMemberId) });
        }
        if (request.method === 'GET' && rankingMatch) {
          const invalidRankingQuery = () => error(
            400,
            `invalid_${rankingMatch[1]}_query`,
            `${rankingMatch[1] === 'popular' ? 'Popular' : 'Trending'} query is invalid`,
          );
          if ([...url.searchParams.keys()].some((key) => key !== 'limit' && key !== 'cursor')) {
            return invalidRankingQuery();
          }
          const limitValue = url.searchParams.get('limit');
          const limit = limitValue === null ? 20 : Number(limitValue);
          if (!Number.isInteger(limit) || limit < 1 || limit > 50 || (limitValue && String(limit) !== limitValue)) {
            return invalidRankingQuery();
          }
          const list = rankingMatch[1] === 'popular'
            ? input.repository.listPopular.bind(input.repository)
            : input.trending.list.bind(input.trending);
          return Response.json(await list({
            kind: targetKind(rankingMatch[2]),
            limit,
            cursor: url.searchParams.get('cursor'),
          }));
        }
        return new Response(null, { status: 404 });
      } catch (cause) {
        if (cause instanceof LikeTargetNotFoundError) {
          return error(404, 'like_target_not_found', 'Like target not found');
        }
        if (cause instanceof SelfLikeForbiddenError) {
          return error(403, 'self_like_forbidden', 'Members cannot like their own content');
        }
        const denied = communityWriteErrorResponse(cause);
        if (denied) return denied;
        if (cause instanceof InvalidPopularCursorError) {
          return error(400, 'invalid_popular_cursor', 'Popular cursor is invalid');
        }
        if (cause instanceof InvalidTrendingCursorError) {
          return error(400, 'invalid_trending_cursor', 'Trending cursor is invalid');
        }
        return error(503, 'marketplace_unavailable', 'Marketplace is temporarily unavailable');
      }
    },
  };
}

function error(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}
