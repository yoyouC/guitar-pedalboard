import type { SessionVerifier } from '../auth/session.ts';
import type { MemberRepository } from '../members/repository.ts';
import type { MarketplaceLikeTargetKind } from '../../shared/marketplace.ts';
import {
  InvalidPopularCursorError,
  LikeTargetNotFoundError,
  SelfLikeForbiddenError,
  type MarketplaceLikeRepository,
} from './repository.ts';

const LIKE_PATH = /^\/api\/marketplace\/likes\/(presets|collections)\/([^/]+)$/;
const POPULAR_PATH = /^\/api\/marketplace\/popular\/(presets|collections)$/;
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
  sessions: SessionVerifier;
  members: MemberRepository;
  now(): Date;
  createMemberId(): string;
  createHandleSuffix(): string;
}): MarketplaceLikesApi {
  const memberId = async (request: Request): Promise<string | null> => {
    const identity = await input.sessions.verify(request);
    if (!identity) return null;
    const member = await input.members.findOrCreateForIdentity({
      id: input.createMemberId(), identity,
      handle: `player-${input.createHandleSuffix()}`, now: input.now(),
    });
    return member.id;
  };

  return {
    async fetch(request) {
      const url = new URL(request.url);
      const likeMatch = LIKE_PATH.exec(url.pathname);
      const popularMatch = POPULAR_PATH.exec(url.pathname);
      try {
        if (likeMatch && ['GET', 'PUT', 'DELETE'].includes(request.method)) {
          const kind = targetKind(likeMatch[1]);
          const targetId = decodeURIComponent(likeMatch[2]);
          const currentMemberId = await memberId(request);
          if (request.method === 'GET') {
            return Response.json({
              state: await input.repository.getState(kind, targetId, currentMemberId),
            });
          }
          if (!currentMemberId) return error(401, 'authentication_required', 'Authentication required');
          if ((await request.text()).trim()) {
            return error(400, 'invalid_like', 'Like requests do not accept a body');
          }
          return Response.json({
            state: await input.repository.setLiked({
              kind, targetId, memberId: currentMemberId,
              liked: request.method === 'PUT', now: input.now(),
            }),
          });
        }
        if (request.method === 'GET' && url.pathname === MY_LIKES_PATH) {
          const currentMemberId = await memberId(request);
          if (!currentMemberId) return error(401, 'authentication_required', 'Authentication required');
          return Response.json({ likes: await input.repository.listMine(currentMemberId) });
        }
        if (request.method === 'GET' && popularMatch) {
          if ([...url.searchParams.keys()].some((key) => key !== 'limit' && key !== 'cursor')) {
            return error(400, 'invalid_popular_query', 'Popular query is invalid');
          }
          const limitValue = url.searchParams.get('limit');
          const limit = limitValue === null ? 20 : Number(limitValue);
          if (!Number.isInteger(limit) || limit < 1 || limit > 50 || (limitValue && String(limit) !== limitValue)) {
            return error(400, 'invalid_popular_query', 'Popular query is invalid');
          }
          return Response.json(await input.repository.listPopular({
            kind: targetKind(popularMatch[1]),
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
        if (cause instanceof InvalidPopularCursorError) {
          return error(400, 'invalid_popular_cursor', 'Popular cursor is invalid');
        }
        return error(503, 'marketplace_unavailable', 'Marketplace is temporarily unavailable');
      }
    },
  };
}

function error(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}
