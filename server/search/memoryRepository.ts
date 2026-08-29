import type { MemberRecord } from '../members/repository.ts';
import type { PresetCollection } from '../../shared/marketplace.ts';
import type {
  MarketplaceDiscoveryRepository,
  MarketplaceDiscoverySearchInput,
} from './repository.ts';
import {
  decodeDiscoveryCursor,
  encodeDiscoveryCursor,
  type MarketplaceDiscoveryKind,
} from './discoveryCursor.ts';
import { isAfterCursor, isAtOrBefore, type SearchBoundary } from './cursor.ts';
import { matchesSearchText } from './text.ts';

interface Discoverable {
  id: string;
  createdAt: string;
}

function boundary(item: Discoverable): SearchBoundary {
  return { id: item.id, createdAt: item.createdAt };
}

function page<Item extends Discoverable>(
  kind: MarketplaceDiscoveryKind,
  input: MarketplaceDiscoverySearchInput,
  items: Item[],
): { items: Item[]; nextCursor: string | null } {
  const cursor = decodeDiscoveryCursor(kind, input);
  const sorted = [...items].sort((left, right) => (
    right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
  ));
  const snapshot = cursor?.snapshot ?? (sorted[0] ? boundary(sorted[0]) : null);
  if (!snapshot) return { items: [], nextCursor: null };
  const candidates = sorted.filter((item) => (
    isAtOrBefore(boundary(item), snapshot)
    && (!cursor || isAfterCursor(boundary(item), cursor.after))
  ));
  const selected = candidates.slice(0, input.limit);
  const last = selected.at(-1);
  return {
    items: selected,
    nextCursor: candidates.length > input.limit && last
      ? encodeDiscoveryCursor(kind, input, snapshot, boundary(last))
      : null,
  };
}

export function createMemoryMarketplaceDiscoveryRepository(input: {
  collections: readonly PresetCollection[] | (() => Promise<readonly PresetCollection[]>);
  members: readonly MemberRecord[] | (() => Promise<readonly MemberRecord[]>);
}): MarketplaceDiscoveryRepository {
  const collections = async () => typeof input.collections === 'function'
    ? input.collections()
    : input.collections;
  const members = async () => typeof input.members === 'function' ? input.members() : input.members;
  return {
    async searchPublicCollections(request) {
      const items = (await collections())
        .filter((collection) => collection.visibility === 'public')
        .filter((collection) => matchesSearchText(request.text, [
          collection.title,
          collection.description,
          collection.creator.handle,
          ...collection.tags.flatMap((tag) => [tag.nameZh, tag.nameEn]),
        ]))
        .map((collection) => ({
          id: collection.id,
          title: collection.title,
          description: collection.description,
          creator: structuredClone(collection.creator),
          tags: structuredClone(collection.tags),
          url: `/marketplace/collections/${encodeURIComponent(collection.id)}`,
          createdAt: collection.createdAt,
          updatedAt: collection.updatedAt,
        }));
      return page('collections', request, items);
    },

    async searchCreators(request) {
      const items = (await members())
        .filter((member) => matchesSearchText(request.text, [member.handle, member.displayName]))
        .map((member) => ({
          id: member.id,
          handle: member.handle,
          displayName: member.displayName,
          bio: member.bio,
          avatarUrl: member.avatarUrl,
          url: `/creators/id/${encodeURIComponent(member.id)}`,
          createdAt: member.createdAt.toISOString(),
        }));
      return page('creators', request, items);
    },
  };
}
