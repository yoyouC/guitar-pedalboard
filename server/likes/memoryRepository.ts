import type {
  MarketplaceLikeTargetKind,
  MarketplaceLikeTargetSummary,
  PresetCollection,
  PublishedPreset,
} from '../../shared/marketplace.js';
import { decodePopularCursor, encodePopularCursor, followsPopularBoundary } from './cursor.js';
import type { MarketplaceLikeFactSource } from './factSource.js';
import {
  InvalidPopularCursorError,
  LikeTargetNotFoundError,
  SelfLikeForbiddenError,
  type MarketplaceLikeRepository,
} from './repository.js';
import type { MarketplaceAccountExport } from '../../shared/account.js';

interface Target {
  id: string;
  title: string;
  visibility: PublishedPreset['visibility'];
  creator: PublishedPreset['creator'];
}

export function createMemoryMarketplaceLikeRepository(input: {
  presets: readonly PublishedPreset[];
  collections: readonly PresetCollection[];
  bannedMemberIds?: ReadonlySet<string>;
  writeAllowed?(memberId: string): Promise<void>;
}): MarketplaceLikeRepository & MarketplaceLikeFactSource & {
  rebuildCounts(): Promise<void>;
  setTargetVisibility(
    kind: MarketplaceLikeTargetKind,
    targetId: string,
    visibility: PublishedPreset['visibility'],
  ): Promise<void>;
  exportForAccount(memberId: string): Promise<Pick<
    MarketplaceAccountExport['relationships'],
    'presetLikes' | 'collectionLikes'
  >>;
  purgeAccount(memberId: string): Promise<void>;
  setAccountTargetVisibility(
    kind: MarketplaceLikeTargetKind,
    targetId: string,
    visibility: PublishedPreset['visibility'],
  ): Promise<void>;
} {
  const presets = new Map(input.presets.map((target) => [target.id, target]));
  const collections = new Map(input.collections.map((target) => [target.id, target]));
  const likes = new Map<string, string>();
  const countHistory = new Map<string, Array<{ rankVersion: number; likeCount: number }>>();
  let rankVersion = 0;
  const targets = (kind: MarketplaceLikeTargetKind) => kind === 'preset' ? presets : collections;
  const key = (kind: MarketplaceLikeTargetKind, targetId: string, memberId: string) => (
    `${kind}\u0000${targetId}\u0000${memberId}`
  );
  const visible = (target: Target | undefined) => target
    && (target.visibility === 'public' || target.visibility === 'unlisted');
  const requireTarget = (kind: MarketplaceLikeTargetKind, id: string): Target => {
    const target = targets(kind).get(id) as Target | undefined;
    if (!visible(target)) throw new LikeTargetNotFoundError();
    return target!;
  };
  const count = (kind: MarketplaceLikeTargetKind, id: string) => [...likes.keys()]
    .filter((value) => {
      const [likeKind, targetId, memberId] = value.split('\u0000');
      return likeKind === kind && targetId === id && !input.bannedMemberIds?.has(memberId);
    }).length;
  const historyKey = (kind: MarketplaceLikeTargetKind, id: string) => `${kind}\u0000${id}`;
  const recordCount = (kind: MarketplaceLikeTargetKind, id: string) => {
    rankVersion += 1;
    const targetHistory = countHistory.get(historyKey(kind, id)) ?? [];
    targetHistory.push({ rankVersion, likeCount: count(kind, id) });
    countHistory.set(historyKey(kind, id), targetHistory);
  };
  const countAt = (kind: MarketplaceLikeTargetKind, id: string, snapshotVersion: number) => {
    const targetHistory = countHistory.get(historyKey(kind, id)) ?? [];
    return targetHistory.findLast((entry) => entry.rankVersion <= snapshotVersion)?.likeCount ?? 0;
  };
  const summary = (
    kind: MarketplaceLikeTargetKind,
    target: Target,
    likeCount = count(kind, target.id),
  ): MarketplaceLikeTargetSummary => ({
    id: target.id,
    title: target.title,
    creator: structuredClone(target.creator),
    likeCount,
  });

  return {
    async getState(kind, targetId, memberId) {
      const target = requireTarget(kind, targetId);
      return {
        liked: memberId ? likes.has(key(kind, targetId, memberId)) : false,
        canLike: Boolean(memberId && memberId !== target.creator.id),
        likeCount: count(kind, targetId),
      };
    },
    async setLiked({ kind, targetId, memberId, liked, now }) {
      await input.writeAllowed?.(memberId);
      const target = requireTarget(kind, targetId);
      if (target.creator.id === memberId) throw new SelfLikeForbiddenError();
      const likeKey = key(kind, targetId, memberId);
      const changed = liked ? !likes.has(likeKey) : likes.has(likeKey);
      if (liked && changed) likes.set(likeKey, now.toISOString());
      if (!liked && changed) likes.delete(likeKey);
      if (changed) recordCount(kind, targetId);
      return { liked: likes.has(likeKey), canLike: true, likeCount: count(kind, targetId) };
    },
    async listMine(memberId) {
      const list = (kind: MarketplaceLikeTargetKind) => [...targets(kind).values()]
        .flatMap((target) => {
          const likedAt = likes.get(key(kind, target.id, memberId));
          return likedAt && visible(target as Target)
            ? [{ ...summary(kind, target as Target), likedAt }]
            : [];
        })
        .sort((left, right) => right.likedAt.localeCompare(left.likedAt) || right.id.localeCompare(left.id));
      return { presets: list('preset'), collections: list('collection') };
    },
    async listPopular({ kind, limit, cursor }) {
      const cursorState = cursor ? decodePopularCursor(cursor, kind, limit) : null;
      if (cursorState && cursorState.snapshotVersion > rankVersion) throw new InvalidPopularCursorError();
      const snapshotVersion = cursorState?.snapshotVersion ?? rankVersion;
      const ranked = [...targets(kind).values()]
        .filter((target) => target.visibility === 'public')
        .map((target) => summary(
          kind,
          target as Target,
          countAt(kind, target.id, snapshotVersion),
        ))
        .filter((target) => target.likeCount > 0)
        .sort((left, right) => right.likeCount - left.likeCount || right.id.localeCompare(left.id))
        .filter((target) => !cursorState || followsPopularBoundary(target, cursorState))
        .slice(0, limit + 1);
      const hasMore = ranked.length > limit;
      const items = ranked.slice(0, limit);
      const last = items.at(-1);
      return {
        items,
        nextCursor: hasMore && last
          ? encodePopularCursor(kind, limit, snapshotVersion, last)
          : null,
      };
    },
    async listActiveLikes() {
      return [...likes.entries()].map(([likeKey, likedAt]) => {
        const [kind, targetId, memberId] = likeKey.split('\u0000');
        return {
          kind: kind as MarketplaceLikeTargetKind,
          targetId,
          memberId,
          likedAt: new Date(likedAt),
        };
      });
    },
    async rebuildCounts() {
      for (const kind of ['preset', 'collection'] as const) {
        for (const target of targets(kind).values()) recordCount(kind, target.id);
      }
    },
    async setTargetVisibility(kind, targetId, visibility) {
      const target = targets(kind).get(targetId);
      if (!target) throw new LikeTargetNotFoundError();
      target.visibility = visibility;
    },
    async exportForAccount(memberId) {
      const entries = [...likes.entries()]
        .filter(([likeKey]) => likeKey.endsWith(`\u0000${memberId}`));
      return {
        presetLikes: entries.flatMap(([likeKey, createdAt]) => {
          const [kind, presetId] = likeKey.split('\u0000');
          return kind === 'preset' ? [{ presetId, createdAt }] : [];
        }),
        collectionLikes: entries.flatMap(([likeKey, createdAt]) => {
          const [kind, collectionId] = likeKey.split('\u0000');
          return kind === 'collection' ? [{ collectionId, createdAt }] : [];
        }),
      };
    },
    async purgeAccount(memberId) {
      const removedTargets = new Set<string>();
      for (const likeKey of [...likes.keys()]) {
        const [kind, targetId, likerId] = likeKey.split('\u0000');
        const target = targets(kind as MarketplaceLikeTargetKind).get(targetId) as Target | undefined;
        if (likerId !== memberId && target?.creator.id !== memberId) continue;
        likes.delete(likeKey);
        removedTargets.add(`${kind}\u0000${targetId}`);
      }
      for (const value of removedTargets) {
        const [kind, targetId] = value.split('\u0000');
        recordCount(kind as MarketplaceLikeTargetKind, targetId);
      }
    },
    async setAccountTargetVisibility(kind, targetId, visibility) {
      const target = targets(kind).get(targetId);
      if (target) target.visibility = visibility;
    },
  };
}
