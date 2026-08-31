import type {
  MarketplaceTag,
  PublishedPreset,
  PublishedPresetConcurrencyState,
  PublishedPresetRevision,
  PublishedPresetRevisionView,
} from '../../shared/marketplace.js';
import type {
  PublishedPresetManagementRepository,
  PublishedPresetPublicationRepository,
  PublishedPresetRepository,
  PublishedPresetRevisionReferenceRepository,
} from './repository.js';
import {
  PublishedPresetAccessError,
  PublishedPresetConflictError,
  PublishedPresetRevisionNotFoundError,
  PublishedPresetSourceError,
  UnavailableTagError,
} from './repository.js';
import { isValidStoredPublishedPresetRevision } from '../../shared/marketplaceValidation.js';
import type { PublishedPresetSearchRepository } from '../search/repository.js';
import { matchesSearchText } from '../search/text.js';
import {
  decodeSearchCursor,
  encodeSearchCursor,
  isAfterCursor,
  isAtOrBefore,
  type SearchBoundary,
} from '../search/cursor.js';
import { rigResourceDependencyKey } from '../../shared/marketplaceResource.js';
import type { MarketplaceAccountExport } from '../../shared/account.js';
import type { ManagedMarketplaceTag } from '../tags/repository.js';

type MemoryMarketplaceTag = MarketplaceTag & {
  aliases?: readonly string[];
  status?: 'active' | 'deprecated' | 'merged';
  mergedIntoId?: string | null;
};

export function createMemoryPublishedPresetRepository(
  presets: readonly PublishedPreset[] = [],
  tags: readonly MemoryMarketplaceTag[] = [],
  writeAllowed?: (memberId: string) => Promise<void>,
): PublishedPresetRepository & PublishedPresetPublicationRepository & PublishedPresetManagementRepository & {
  findRevisionReference: PublishedPresetRevisionReferenceRepository['findRevisionReference'];
  count(): Promise<number>;
  setModerationVisibility(
    presetId: string,
    visibility: PublishedPreset['visibility'],
  ): Promise<void>;
  exportForAccount(memberId: string): Promise<MarketplaceAccountExport['presets']>;
  withdrawForAccountDeletion(
    memberId: string,
    now: Date,
  ): Promise<Record<string, PublishedPreset['visibility']>>;
  restoreForAccountDeletion(
    memberId: string,
    snapshot: Record<string, PublishedPreset['visibility']>,
    now: Date,
  ): Promise<void>;
  purgeAccount(memberId: string, now: Date): Promise<void>;
  snapshotTagAssignments(): ReadonlyMap<string, readonly string[]>;
  synchronizeManagedTags(tags: readonly ManagedMarketplaceTag[]): void;
} & PublishedPresetSearchRepository {
  const presetsById = new Map(presets.map((preset) => [preset.id, preset]));
  const tagsById = new Map<string, MarketplaceTag>();
  const sourceTagsById = new Map<string, MemoryMarketplaceTag>();
  const resolvedTagIds = new Map<string, string | null>();
  const tagAliasesById = new Map<string, readonly string[]>();
  const resolveTagId = (id: string): string | null => {
    const visited = new Set<string>();
    let current = sourceTagsById.get(id);
    while (current?.mergedIntoId) {
      if (visited.has(current.id)) return null;
      visited.add(current.id);
      current = sourceTagsById.get(current.mergedIntoId);
    }
    return current?.id ?? null;
  };
  const rebuildTagCatalog = (
    managedTags: readonly MemoryMarketplaceTag[],
    migratePresets: boolean,
  ) => {
    tagsById.clear();
    sourceTagsById.clear();
    resolvedTagIds.clear();
    tagAliasesById.clear();
    for (const tag of managedTags) sourceTagsById.set(tag.id, tag);
    for (const tag of managedTags) resolvedTagIds.set(tag.id, resolveTagId(tag.id));
    for (const tag of managedTags) {
      const { aliases: _aliases, status: _status, mergedIntoId: _mergedIntoId, ...publicTag } = tag;
      if ((tag.status ?? 'active') === 'active') tagsById.set(tag.id, publicTag);
      tagAliasesById.set(tag.id, [
        ...(tag.aliases ?? []),
        ...managedTags.filter((source) => (
          source.id !== tag.id && resolveTagId(source.id) === tag.id
        )).flatMap((source) => [
          ...(source.aliases ?? []), source.id, source.nameZh, source.nameEn,
        ]),
      ]);
    }
    if (!migratePresets) return;
    for (const preset of presetsById.values()) {
      const seen = new Set<string>();
      const nextTags = preset.tags.flatMap((tag) => {
        const resolvedId = resolveTagId(tag.id) ?? tag.id;
        if (seen.has(resolvedId)) return [];
        seen.add(resolvedId);
        const source = sourceTagsById.get(resolvedId);
        if (!source) return [tag];
        return [{
          id: source.id, dimension: source.dimension,
          nameZh: source.nameZh, nameEn: source.nameEn,
        }];
      });
      presetsById.set(preset.id, { ...preset, tags: nextTags });
    }
  };
  rebuildTagCatalog(tags, false);
  const revisionsByPresetId = new Map<string, Map<string, PublishedPresetRevision>>(
    presets.map((preset) => [
      preset.id,
      new Map([[preset.currentRevision.id, preset.currentRevision]]),
    ]),
  );

  const clone = <T>(value: T): T => structuredClone(value);

  function hydrateSource(preset: PublishedPreset): PublishedPreset {
    if (!preset.source) return preset;
    const sourcePreset = presetsById.get(preset.source.presetId);
    const sourceRevision = revisionsByPresetId
      .get(preset.source.presetId)
      ?.get(preset.source.revisionId);
    if (!sourcePreset || !sourceRevision) throw new PublishedPresetSourceError();
    const available = sourcePreset.visibility === 'public' || sourcePreset.visibility === 'unlisted';
    return {
      ...preset,
      source: {
        presetId: sourcePreset.id,
        revisionId: sourceRevision.id,
        creator: sourcePreset.creator,
        availability: available ? 'available' : 'unavailable',
        title: available ? sourcePreset.title : null,
      },
    };
  }

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
    return clone(hydrateSource(preset));
  }

  function nextUpdatedAt(preset: PublishedPreset, now: Date): string {
    return new Date(Math.max(now.getTime(), Date.parse(preset.updatedAt) + 1)).toISOString();
  }

  return {
    snapshotTagAssignments() {
      return new Map([...presetsById].map(([id, preset]) => [
        id, preset.tags.map((tag) => tag.id),
      ]));
    },
    synchronizeManagedTags(managedTags) {
      rebuildTagCatalog(managedTags, true);
    },
    async searchPublicPresets(input) {
      const candidates = [...presetsById.values()]
        .filter((preset) => preset.visibility === 'public')
        .filter((preset) => input.tagIds.every((id) => {
          const resolvedId = resolvedTagIds.get(id);
          return Boolean(resolvedId) && preset.tags.some((tag) => tag.id === resolvedId);
        }))
        .filter((preset) => input.pedalIds.every((id) => preset.derivedAttributes.pedalIds.includes(id)))
        .filter((preset) => input.ampIds.length === 0 || input.ampIds.includes(preset.derivedAttributes.ampId))
        .filter((preset) => input.cabIds.length === 0 || input.cabIds.includes(preset.derivedAttributes.cabId))
        .filter((preset) => input.resourceKinds.every((kind) => (
          preset.derivedAttributes.resourceKinds.includes(kind)
        )))
        .filter((preset) => input.resourceDependencyKeys.every((key) => (
          preset.currentRevision.resourceDependencies.some((dependency) => (
            rigResourceDependencyKey(dependency) === key
          ))
        )))
        .filter((preset) => !input.publishedAfter || preset.createdAt >= input.publishedAfter)
        .filter((preset) => !input.publishedBefore || preset.createdAt <= input.publishedBefore)
        .sort((left, right) => (
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
        ));
      const cursor = input.cursor ? decodeSearchCursor(input.cursor, input) : null;
      const snapshot: SearchBoundary | null = cursor?.snapshot ?? (candidates[0]
        ? { createdAt: candidates[0].createdAt, id: candidates[0].id }
        : null);
      if (!snapshot) return { items: [], nextCursor: null };
      const matches = candidates
        .filter((preset) => isAtOrBefore(preset, snapshot))
        .filter((preset) => !cursor || isAfterCursor(preset, cursor.after))
        .filter((preset) => matchesSearchText(input.text, [
          preset.title,
          preset.description,
          preset.creator.handle,
          ...preset.tags.flatMap((tag) => [
            tag.nameZh,
            tag.nameEn,
            ...(tagAliasesById.get(tag.id) ?? []),
          ]),
        ]))
        .slice(0, input.limit + 1);
      const hasMore = matches.length > input.limit;
      const pagePresets = matches.slice(0, input.limit);
      const items = pagePresets
        .map((preset) => ({
          id: preset.id,
          title: preset.title,
          description: preset.description,
          creator: clone(preset.creator),
          tags: clone(preset.tags),
          derivedAttributes: clone(preset.derivedAttributes),
          resourceDependencies: clone(preset.currentRevision.resourceDependencies),
          isRemix: Boolean(preset.source),
          createdAt: preset.createdAt,
          updatedAt: preset.updatedAt,
        }));
      const last = pagePresets.at(-1);
      return {
        items,
        nextCursor: hasMore && last
          ? encodeSearchCursor(input, snapshot, { createdAt: last.createdAt, id: last.id })
          : null,
      };
    },

    async findRevisionReference(presetId, revisionId) {
      const preset = presetsById.get(presetId);
      const revision = revisionsByPresetId.get(presetId)?.get(revisionId);
      if (!preset || !revision) return null;
      return clone({
        presetId,
        revisionId,
        title: preset.title,
        visibility: preset.visibility,
        creator: preset.creator,
      });
    },

    async findVisibleById(id) {
      const preset = presetsById.get(id);
      return preset && (preset.visibility === 'public' || preset.visibility === 'unlisted')
        ? clone(hydrateSource(preset))
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
      const source = hydrateSource(preset).source;
      const view: PublishedPresetRevisionView = {
        id: preset.id,
        title: preset.title,
        description: preset.description,
        visibility: preset.visibility,
        creator: preset.creator,
        tags: preset.tags,
        revision,
        currentRevisionId: preset.currentRevision.id,
        ...(source ? { source } : {}),
        createdAt: preset.createdAt,
        updatedAt: preset.updatedAt,
      };
      return clone(view);
    },

    async listAvailableTags() {
      return [...tagsById.values()].map((tag) => ({ ...tag }));
    },

    async create(input) {
      await writeAllowed?.(input.creator.id);
      const selectedTags = input.tagIds.map((id) => tagsById.get(id));
      if (selectedTags.some((tag) => !tag)) throw new UnavailableTagError();
      let source;
      if (input.source) {
        const sourcePreset = presetsById.get(input.source.presetId);
        const sourceRevision = revisionsByPresetId
          .get(input.source.presetId)
          ?.get(input.source.revisionId);
        if (
          !sourcePreset
          || !sourceRevision
          || sourcePreset.creator.id === input.creator.id
          || (sourcePreset.visibility !== 'public' && sourcePreset.visibility !== 'unlisted')
        ) throw new PublishedPresetSourceError();
        source = {
          ...input.source,
          creator: sourcePreset.creator,
          availability: 'available' as const,
          title: sourcePreset.title,
        };
      }
      const createdAt = input.now.toISOString();
      const preset: PublishedPreset = {
        id: input.id,
        title: input.title,
        description: input.description,
        visibility: input.visibility ?? 'public',
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
        ...(source ? { source } : {}),
        createdAt,
        updatedAt: createdAt,
      };
      presetsById.set(preset.id, preset);
      revisionsByPresetId.set(preset.id, new Map([[preset.currentRevision.id, preset.currentRevision]]));
      return clone(hydrateSource(preset));
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
      return clone(hydrateSource(ownedCurrent(presetId, creatorId)));
    },

    async listManagedByCreator(creatorId) {
      return [...presetsById.values()]
        .filter((preset) => preset.creator.id === creatorId && preset.visibility !== 'hidden')
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map((preset) => clone(hydrateSource(preset)));
    },

    async updateMetadata(input) {
      await writeAllowed?.(input.creatorId);
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
      await writeAllowed?.(input.creatorId);
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
      await writeAllowed?.(input.creatorId);
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
      await writeAllowed?.(input.creatorId);
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

    async setModerationVisibility(presetId, visibility) {
      const preset = presetsById.get(presetId);
      if (!preset) throw new PublishedPresetAccessError();
      preset.visibility = visibility;
    },

    async exportForAccount(memberId) {
      return [...presetsById.values()]
        .filter((preset) => preset.creator.id === memberId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
        .map((preset) => ({
          id: preset.id,
          title: preset.title,
          description: preset.description,
          visibility: preset.visibility,
          tagIds: preset.tags.map((tag) => tag.id).sort(),
          source: preset.source
            ? { presetId: preset.source.presetId, revisionId: preset.source.revisionId }
            : null,
          revisions: [...(revisionsByPresetId.get(preset.id)?.values() ?? [])]
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
            .map((revision) => ({
              id: revision.id,
              schemaVersion: revision.schemaVersion,
              resourceDependencies: clone(revision.resourceDependencies),
              derivedAttributes: clone(revision.derivedAttributes),
              rig: clone(revision.rig),
              createdAt: revision.createdAt,
            })),
          createdAt: preset.createdAt,
          updatedAt: preset.updatedAt,
        }));
    },

    async withdrawForAccountDeletion(memberId, now) {
      const snapshot: Record<string, PublishedPreset['visibility']> = {};
      for (const preset of presetsById.values()) {
        if (preset.creator.id !== memberId
          || (preset.visibility !== 'public' && preset.visibility !== 'unlisted')) continue;
        snapshot[preset.id] = preset.visibility;
        presetsById.set(preset.id, {
          ...preset, visibility: 'withdrawn', updatedAt: nextUpdatedAt(preset, now),
        });
      }
      return snapshot;
    },

    async restoreForAccountDeletion(memberId, snapshot, now) {
      for (const [presetId, visibility] of Object.entries(snapshot)) {
        const preset = presetsById.get(presetId);
        if (!preset || preset.creator.id !== memberId || preset.visibility !== 'withdrawn') continue;
        presetsById.set(presetId, {
          ...preset, visibility, updatedAt: nextUpdatedAt(preset, now),
        });
      }
    },

    async purgeAccount(memberId, now) {
      for (const preset of presetsById.values()) {
        if (preset.creator.id !== memberId) continue;
        const revisions = revisionsByPresetId.get(preset.id);
        for (const [revisionId, revision] of revisions ?? []) {
          revisions!.set(revisionId, {
            ...revision,
            rig: {},
            resourceDependencies: [],
            derivedAttributes: {},
          } as unknown as PublishedPresetRevision);
        }
        const currentRevision = revisions?.get(preset.currentRevision.id) ?? preset.currentRevision;
        presetsById.set(preset.id, {
          ...preset,
          title: 'Deleted preset',
          description: '',
          visibility: 'withdrawn',
          tags: [],
          creator: { ...preset.creator, handle: 'deleted-member', displayName: 'Deleted member' },
          derivedAttributes: {} as PublishedPreset['derivedAttributes'],
          currentRevision,
          updatedAt: nextUpdatedAt(preset, now),
        });
      }
    },
  };
}
