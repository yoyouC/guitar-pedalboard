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
): PresetCollectionRepository & PresetCollectionManagementRepository & {
  listForDiscovery(): Promise<PresetCollection[]>;
  setModerationVisibility(
    collectionId: string,
    visibility: PresetCollection['visibility'],
  ): Promise<void>;
} {
  const tagsById = new Map(tags.map((tag) => [tag.id, tag]));
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
    if (tagIds.some((tagId) => !tagsById.has(tagId))) throw new PresetCollectionTagError();
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
      return [...tagsById.values()].map(publicTag);
    },

    async create(input) {
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
  };
}
