import type {
  MarketplaceTag,
  PublishedPreset,
  PublishedPresetConcurrencyState,
  PublishedPresetRevision,
  PublishedPresetRevisionView,
} from '../../shared/marketplace.ts';
import type {
  PublishedPresetManagementRepository,
  PublishedPresetPublicationRepository,
  PublishedPresetRepository,
} from './repository.ts';
import {
  PublishedPresetAccessError,
  PublishedPresetConflictError,
  PublishedPresetRevisionNotFoundError,
  UnavailableTagError,
} from './repository.ts';
import { isValidStoredPublishedPresetRevision } from '../../shared/marketplaceValidation.ts';

export function createMemoryPublishedPresetRepository(
  presets: readonly PublishedPreset[] = [],
  tags: readonly MarketplaceTag[] = [],
): PublishedPresetRepository & PublishedPresetPublicationRepository & PublishedPresetManagementRepository & {
  count(): Promise<number>;
} {
  const presetsById = new Map(presets.map((preset) => [preset.id, preset]));
  const tagsById = new Map(tags.map((tag) => [tag.id, tag]));
  const revisionsByPresetId = new Map<string, Map<string, PublishedPresetRevision>>(
    presets.map((preset) => [
      preset.id,
      new Map([[preset.currentRevision.id, preset.currentRevision]]),
    ]),
  );

  const clone = <T>(value: T): T => structuredClone(value);

  function concurrencyState(preset: PublishedPreset): PublishedPresetConcurrencyState {
    return {
      updatedAt: preset.updatedAt,
      currentRevisionId: preset.currentRevision.id,
      visibility: preset.visibility,
    };
  }

  function ownedCurrent(
    presetId: string,
    creatorId: string,
    expectedUpdatedAt?: Date,
  ): PublishedPreset {
    const preset = presetsById.get(presetId);
    if (!preset || preset.creator.id !== creatorId || preset.visibility === 'hidden') {
      throw new PublishedPresetAccessError();
    }
    if (expectedUpdatedAt && Date.parse(preset.updatedAt) !== expectedUpdatedAt.getTime()) {
      throw new PublishedPresetConflictError(concurrencyState(preset));
    }
    return preset;
  }

  function setCurrent(preset: PublishedPreset): PublishedPreset {
    presetsById.set(preset.id, preset);
    return clone(preset);
  }

  function nextUpdatedAt(preset: PublishedPreset, now: Date): string {
    return new Date(Math.max(now.getTime(), Date.parse(preset.updatedAt) + 1)).toISOString();
  }

  return {
    async findVisibleById(id) {
      const preset = presetsById.get(id);
      return preset && (preset.visibility === 'public' || preset.visibility === 'unlisted')
        ? clone(preset)
        : null;
    },

    async findVisibleRevisionById(presetId, revisionId) {
      const preset = presetsById.get(presetId);
      const revision = revisionsByPresetId.get(presetId)?.get(revisionId);
      if (
        !preset
        || !revision
        || (preset.visibility !== 'public' && preset.visibility !== 'unlisted')
      ) return null;
      const view: PublishedPresetRevisionView = {
        id: preset.id,
        title: preset.title,
        description: preset.description,
        visibility: preset.visibility,
        creator: preset.creator,
        tags: preset.tags,
        revision,
        currentRevisionId: preset.currentRevision.id,
        createdAt: preset.createdAt,
        updatedAt: preset.updatedAt,
      };
      return clone(view);
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
          payloadKind: 'canonical-rig',
          id: input.revisionId,
          schemaVersion: input.schemaVersion,
          resourceDependencies: input.resourceDependencies,
          derivedAttributes: input.derivedAttributes,
          rig: input.rig,
          createdAt,
        },
        createdAt,
        updatedAt: createdAt,
      };
      presetsById.set(preset.id, preset);
      revisionsByPresetId.set(preset.id, new Map([[preset.currentRevision.id, preset.currentRevision]]));
      return clone(preset);
    },

    async listRevisions(presetId, creatorId) {
      const preset = ownedCurrent(presetId, creatorId);
      return [...(revisionsByPresetId.get(presetId)?.values() ?? [])]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
        .map((revision) => ({
          id: revision.id,
          createdAt: revision.createdAt,
          isCurrent: revision.id === preset.currentRevision.id,
        }));
    },

    async findManagedById(presetId, creatorId) {
      return clone(ownedCurrent(presetId, creatorId));
    },

    async updateMetadata(input) {
      const preset = ownedCurrent(input.presetId, input.creatorId, input.expectedUpdatedAt);
      const selectedTags = input.tagIds.map((id) => tagsById.get(id));
      if (selectedTags.some((tag) => !tag)) throw new UnavailableTagError();
      return setCurrent({
        ...preset,
        title: input.title,
        description: input.description,
        tags: selectedTags as MarketplaceTag[],
        updatedAt: nextUpdatedAt(preset, input.now),
      });
    },

    async appendRevision(input) {
      const preset = ownedCurrent(input.presetId, input.creatorId, input.expectedUpdatedAt);
      const revision: PublishedPresetRevision = {
        payloadKind: 'canonical-rig',
        id: input.revisionId,
        schemaVersion: input.schemaVersion,
        rig: clone(input.rig),
        resourceDependencies: clone(input.resourceDependencies),
        derivedAttributes: clone(input.derivedAttributes),
        createdAt: input.now.toISOString(),
      };
      revisionsByPresetId.get(input.presetId)?.set(revision.id, revision);
      return setCurrent({
        ...preset,
        derivedAttributes: clone(input.derivedAttributes),
        currentRevision: revision,
        updatedAt: nextUpdatedAt(preset, input.now),
      });
    },

    async restoreRevision(input) {
      const preset = ownedCurrent(input.presetId, input.creatorId, input.expectedUpdatedAt);
      const source = revisionsByPresetId.get(input.presetId)?.get(input.sourceRevisionId);
      if (!source) throw new PublishedPresetRevisionNotFoundError();
      const revision: PublishedPresetRevision = {
        ...clone(source),
        id: input.revisionId,
        createdAt: input.now.toISOString(),
      };
      if (!isValidStoredPublishedPresetRevision(revision)) {
        throw new PublishedPresetRevisionNotFoundError();
      }
      revisionsByPresetId.get(input.presetId)?.set(revision.id, revision);
      return setCurrent({
        ...preset,
        currentRevision: revision,
        derivedAttributes: clone(revision.derivedAttributes),
        updatedAt: nextUpdatedAt(preset, input.now),
      });
    },

    async updateVisibility(input) {
      const preset = ownedCurrent(input.presetId, input.creatorId, input.expectedUpdatedAt);
      return setCurrent({
        ...preset,
        visibility: input.visibility,
        updatedAt: nextUpdatedAt(preset, input.now),
      });
    },

    async count() {
      return presetsById.size;
    },
  };
}
