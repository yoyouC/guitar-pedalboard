import type { MarketplaceTag, PublishedPreset } from '../../shared/marketplace.ts';
import type {
  PublishedPresetPublicationRepository,
  PublishedPresetRepository,
} from './repository.ts';
import { UnavailableTagError } from './repository.ts';

export function createMemoryPublishedPresetRepository(
  presets: readonly PublishedPreset[] = [],
  tags: readonly MarketplaceTag[] = [],
): PublishedPresetRepository & PublishedPresetPublicationRepository & { count(): Promise<number> } {
  const presetsById = new Map(presets.map((preset) => [preset.id, preset]));
  const tagsById = new Map(tags.map((tag) => [tag.id, tag]));

  return {
    async findPublicById(id) {
      const preset = presetsById.get(id);
      return preset?.visibility === 'public' ? preset : null;
    },

    async listAvailableTags() {
      return [...tagsById.values()].map((tag) => ({ ...tag }));
    },

    async create(input) {
      const selectedTags = input.tagIds.map((id) => tagsById.get(id));
      if (selectedTags.some((tag) => !tag)) throw new UnavailableTagError();
      const createdAt = input.now.toISOString();
      const preset: PublishedPreset = {
        id: input.id,
        title: input.title,
        description: input.description,
        visibility: 'public',
        creator: input.creator,
        tags: selectedTags as MarketplaceTag[],
        derivedAttributes: input.derivedAttributes,
        currentRevision: {
          id: input.revisionId,
          schemaVersion: input.schemaVersion,
          resourceDependencies: input.resourceDependencies,
          rig: input.rig,
          createdAt,
        },
        createdAt,
        updatedAt: createdAt,
      };
      presetsById.set(preset.id, preset);
      return preset;
    },

    async count() {
      return presetsById.size;
    },
  };
}
