import type {
  MarketplaceTag,
  PresetCollection,
} from '../../shared/marketplace.ts';
import {
  PresetCollectionAccessError,
  PresetCollectionConflictError,
  PresetCollectionReferenceError,
  PresetCollectionTagError,
} from './repository.ts';
import type { ManagedMarketplaceTag } from '../tags/repository.ts';

type MemoryCollectionTag = MarketplaceTag & { aliases?: readonly string[] };
import type { MarketplaceAccountExport } from '../../shared/account.ts';
import { canIncludePresetRevision } from './referencePolicy.ts';
import type {
  PresetCollectionReferenceSource,
  PresetCollectionManagementRepository,
  PresetCollectionRepository,
  StoredPresetCollection,
} from './repository.ts';

export function createMemoryPresetCollectionRepository(
  initialCollections: readonly PresetCollection[],
  presets: PresetCollectionReferenceSource,
  tags: readonly MarketplaceTag[],
  writeAllowed?: (memberId: string) => Promise<void>,
): PresetCollectionRepository & PresetCollectionManagementRepository & {
  listForDiscovery(): Promise<PresetCollection[]>;
  setModerationVisibility(
    collectionId: string,
    visibility: PresetCollection['visibility'],
  ): Promise<void>;
  exportForAccount(memberId: string): Promise<MarketplaceAccountExport['collections']>;
  withdrawForAccountDeletion(
    memberId: string,
    now: Date,
  ): Promise<Record<string, PresetCollection['visibility']>>;
  restoreForAccountDeletion(
    memberId: string,
    snapshot: Record<string, PresetCollection['visibility']>,
    now: Date,
  ): Promise<void>;
  purgeAccount(memberId: string, now: Date): Promise<void>;
  snapshotTagAssignments(): ReadonlyMap<string, readonly string[]>;
  synchronizeManagedTags(tags: readonly ManagedMarketplaceTag[]): void;
} {
  const tagsById = new Map<string, MemoryCollectionTag>(tags.map((tag) => [tag.id, tag]));
  const activeTagIds = new Set(tags.map((tag) => tag.id));
  const publicTag = (tag: MarketplaceTag): MarketplaceTag => ({
    id: tag.id,
    dimension: tag.dimension,
    nameZh: tag.nameZh,
    nameEn: tag.nameEn,
  });
  const collectionsById = new Map<string, StoredPresetCollection>(initialCollections.map((item) => [
    item.id,
    {
      id: item.id,
      title: item.title,
      description: item.description,
      visibility: item.visibility,
      creator: structuredClone(item.creator),
      tagIds: item.tags.map((tag) => tag.id),
      items: item.items.map(({ presetId, revisionId }) => ({ presetId, revisionId })),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    },
  ]));

  async function project(stored: StoredPresetCollection): Promise<PresetCollection> {
    const items = await Promise.all(stored.items.map(async (item, position) => {
      const reference = await presets.findRevisionReference(item.presetId, item.revisionId);
      if (!reference) throw new Error('Collection preset reference is missing');
      const available = reference.visibility === 'public'
        || (
          stored.visibility === 'unlisted'
          && reference.visibility === 'unlisted'
          && reference.creator.id === stored.creator.id
        );
      return {
        position,
        presetId: item.presetId,
        revisionId: item.revisionId,
        availability: available ? 'available' as const : 'unavailable' as const,
        title: available ? reference.title : null,
        creator: reference.creator,
      };
    }));
    return {
      id: stored.id,
      title: stored.title,
      description: stored.description,
      visibility: stored.visibility,
      creator: structuredClone(stored.creator),
      tags: stored.tagIds.map((tagId) => {
        const tag = tagsById.get(tagId);
        if (!tag) throw new Error('Collection tag is missing');
        return publicTag(tag);
      }),
      items,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
    };
  }

  function owned(
    collectionId: string,
    creatorId: string,
    expectedUpdatedAt?: Date,
  ): StoredPresetCollection {
    const stored = collectionsById.get(collectionId);
    if (!stored || stored.creator.id !== creatorId || stored.visibility === 'hidden') {
      throw new PresetCollectionAccessError();
    }
    if (expectedUpdatedAt && Date.parse(stored.updatedAt) !== expectedUpdatedAt.getTime()) {
      throw new PresetCollectionConflictError({
        updatedAt: stored.updatedAt,
        visibility: stored.visibility,
      });
    }
    return stored;
  }

  function selectedTags(tagIds: readonly string[]): void {
    if (tagIds.some((tagId) => !activeTagIds.has(tagId))) throw new PresetCollectionTagError();
  }

  async function validateReferences(
    stored: StoredPresetCollection,
    visibility: 'public' | 'unlisted' | 'withdrawn',
    items: readonly { presetId: string; revisionId: string }[],
  ): Promise<void> {
    const existing = new Set(stored.items.map((item) => `${item.presetId}\u0000${item.revisionId}`));
    for (const item of items) {
      const reference = await presets.findRevisionReference(item.presetId, item.revisionId);
      if (!reference) throw new PresetCollectionReferenceError();
      const allowed = canIncludePresetRevision({
        targetVisibility: visibility,
        currentVisibility: stored.visibility,
        collectionCreatorId: stored.creator.id,
        presetVisibility: reference.visibility,
        presetCreatorId: reference.creator.id,
        alreadyIncluded: existing.has(`${item.presetId}\u0000${item.revisionId}`),
      });
      if (!allowed) throw new PresetCollectionReferenceError();
    }
  }

  return {
    snapshotTagAssignments() {
      return new Map([...collectionsById].map(([id, collection]) => [
        id, [...collection.tagIds],
      ]));
    },
    synchronizeManagedTags(managedTags) {
      tagsById.clear();
      activeTagIds.clear();
      const managedById = new Map(managedTags.map((tag) => [tag.id, tag]));
      const resolve = (id: string): string | null => {
        const visited = new Set<string>();
        let current = managedById.get(id);
        while (current?.mergedIntoId) {
          if (visited.has(current.id)) return null;
          visited.add(current.id);
          current = managedById.get(current.mergedIntoId);
        }
        return current?.id ?? null;
      };
      for (const tag of managedTags) {
        const { aliases, status, mergedIntoId: _mergedIntoId,
          presetCount: _presetCount, collectionCount: _collectionCount, ...publicTag } = tag;
        tagsById.set(tag.id, {
          ...publicTag,
          aliases: [
            ...aliases,
            ...managedTags.filter((source) => (
              source.id !== tag.id && resolve(source.id) === tag.id
            )).flatMap((source) => [
              ...source.aliases, source.id, source.nameZh, source.nameEn,
            ]),
          ],
        });
        if (status === 'active') activeTagIds.add(tag.id);
      }
      for (const collection of collectionsById.values()) {
        const tagIds = [...new Set(collection.tagIds.map((id) => resolve(id) ?? id))];
        collectionsById.set(collection.id, { ...collection, tagIds });
      }
    },
    async listForDiscovery() {
      return [...collectionsById.values()].map((stored) => ({
        id: stored.id,
        title: stored.title,
        description: stored.description,
        visibility: stored.visibility,
        creator: structuredClone(stored.creator),
        tags: stored.tagIds.map((tagId) => {
          const tag = tagsById.get(tagId);
          if (!tag) throw new Error('Collection tag is missing');
          return { ...tag };
        }),
        items: [],
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
      }));
    },

    async listAvailableTags() {
      return [...tagsById.values()]
        .filter((tag) => activeTagIds.has(tag.id))
        .map(publicTag);
    },

    async create(input) {
      await writeAllowed?.(input.creator.id);
      selectedTags(input.tagIds);
      const timestamp = input.now.toISOString();
      const stored: StoredPresetCollection = {
        id: input.id,
        title: input.title,
        description: input.description,
        visibility: input.visibility,
        creator: structuredClone(input.creator),
        tagIds: [...input.tagIds],
        items: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      collectionsById.set(stored.id, stored);
      return project(stored);
    },

    async findManagedById(collectionId, creatorId) {
      return project(owned(collectionId, creatorId));
    },

    async update(input) {
      await writeAllowed?.(input.creatorId);
      const current = owned(input.collectionId, input.creatorId, input.expectedUpdatedAt);
      selectedTags(input.tagIds);
      await validateReferences(current, input.visibility, input.items);
      const updatedAt = new Date(Math.max(
        input.now.getTime(),
        Date.parse(current.updatedAt) + 1,
      )).toISOString();
      const updated: StoredPresetCollection = {
        ...current,
        title: input.title,
        description: input.description,
        tagIds: [...input.tagIds],
        visibility: input.visibility,
        items: input.items.map((item) => ({ ...item })),
        updatedAt,
      };
      collectionsById.set(updated.id, updated);
      return project(updated);
    },

    async findVisibleById(id) {
      const stored = collectionsById.get(id);
      if (!stored || (stored.visibility !== 'public' && stored.visibility !== 'unlisted')) {
        return null;
      }
      return project(stored);
    },

    async setModerationVisibility(collectionId, visibility) {
      const stored = collectionsById.get(collectionId);
      if (!stored) throw new PresetCollectionAccessError();
      collectionsById.set(collectionId, { ...stored, visibility });
    },
    async exportForAccount(memberId) {
      return [...collectionsById.values()]
        .filter((collection) => collection.creator.id === memberId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
        .map((collection) => ({
          id: collection.id,
          title: collection.title,
          description: collection.description,
          visibility: collection.visibility,
          tagIds: [...collection.tagIds].sort(),
          items: collection.items.map((item, position) => ({ position, ...item })),
          createdAt: collection.createdAt,
          updatedAt: collection.updatedAt,
        }));
    },
    async withdrawForAccountDeletion(memberId, now) {
      const snapshot: Record<string, PresetCollection['visibility']> = {};
      for (const collection of collectionsById.values()) {
        if (collection.creator.id !== memberId
          || (collection.visibility !== 'public' && collection.visibility !== 'unlisted')) continue;
        snapshot[collection.id] = collection.visibility;
        collectionsById.set(collection.id, {
          ...collection, visibility: 'withdrawn', updatedAt: now.toISOString(),
        });
      }
      return snapshot;
    },
    async restoreForAccountDeletion(memberId, snapshot, now) {
      for (const [collectionId, visibility] of Object.entries(snapshot)) {
        const collection = collectionsById.get(collectionId);
        if (!collection || collection.creator.id !== memberId || collection.visibility !== 'withdrawn') continue;
        collectionsById.set(collectionId, {
          ...collection, visibility, updatedAt: now.toISOString(),
        });
      }
    },
    async purgeAccount(memberId, now) {
      for (const collection of collectionsById.values()) {
        if (collection.creator.id !== memberId) continue;
        collectionsById.set(collection.id, {
          ...collection,
          title: 'Deleted collection',
          description: '',
          visibility: 'withdrawn',
          tagIds: [],
          items: [],
          creator: { ...collection.creator, handle: 'deleted-member', displayName: 'Deleted member' },
          updatedAt: now.toISOString(),
        });
      }
    },
  };
}
