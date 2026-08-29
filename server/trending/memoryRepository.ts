import type {
  MarketplaceLikeTargetKind,
  MarketplaceLikeTargetSummary,
  PresetCollection,
  PublishedPreset,
} from '../../shared/marketplace.ts';
import type { MarketplaceLikeFactSource } from '../likes/factSource.ts';
import {
  decodeTrendingCursor,
  encodeTrendingCursor,
  followsTrendingBoundary,
} from './cursor.ts';
import { marketplaceTrendScore } from './policy.ts';
import { InvalidTrendingCursorError, type MarketplaceTrendingRepository } from './repository.ts';

interface Target {
  id: string;
  title: string;
  visibility: PublishedPreset['visibility'];
  creator: PublishedPreset['creator'];
}

type TrendingRow = MarketplaceLikeTargetSummary & { trendScore: number };

export function createMemoryMarketplaceTrendingRepository(input: {
  presets: readonly PublishedPreset[];
  collections: readonly PresetCollection[];
  likes: MarketplaceLikeFactSource;
  bannedMemberIds?: ReadonlySet<string>;
}): MarketplaceTrendingRepository {
  const targetsByKind = {
    preset: new Map(input.presets.map((target) => [target.id, target])),
    collection: new Map(input.collections.map((target) => [target.id, target])),
  };
  const snapshots = new Map<number, Record<MarketplaceLikeTargetKind, TrendingRow[]>>();
  let latestVersion = 0;

  return {
    async list({ kind, limit, cursor }) {
      const cursorState = cursor ? decodeTrendingCursor(cursor, kind, limit) : null;
      if (cursorState && !snapshots.has(cursorState.snapshotVersion)) {
        throw new InvalidTrendingCursorError();
      }
      const snapshotVersion = cursorState?.snapshotVersion ?? latestVersion;
      if (snapshotVersion === 0) return { items: [], nextCursor: null };
      const ranked = (snapshots.get(snapshotVersion)?.[kind] ?? [])
        .filter((target) => !cursorState || followsTrendingBoundary(target, cursorState))
        .slice(0, limit + 1);
      const hasMore = ranked.length > limit;
      const rows = ranked.slice(0, limit);
      const last = rows.at(-1);
      return {
        items: rows.map(({ trendScore: _trendScore, ...target }) => target),
        nextCursor: hasMore && last
          ? encodeTrendingCursor(kind, limit, snapshotVersion, last)
          : null,
      };
    },
    async rebuild({ now, policy }) {
      const activeLikes = await input.likes.listActiveLikes();
      latestVersion += 1;
      const rank = (kind: MarketplaceLikeTargetKind) => [...targetsByKind[kind].values()]
        .filter((target) => target.visibility === 'public')
        .flatMap((target) => {
          const validLikes = activeLikes.filter((like) => (
            like.kind === kind && like.targetId === target.id
            && !input.bannedMemberIds?.has(like.memberId)
          ));
          const trendScore = validLikes.reduce(
            (total, like) => total + marketplaceTrendScore(like.likedAt, now, policy),
            0,
          );
          return trendScore > 0
            ? [{
              id: target.id,
              title: target.title,
              creator: structuredClone((target as Target).creator),
              likeCount: validLikes.length,
              trendScore,
            }]
            : [];
        })
        .sort((left, right) => right.trendScore - left.trendScore || right.id.localeCompare(left.id));
      snapshots.set(latestVersion, { preset: rank('preset'), collection: rank('collection') });
    },
  };
}
