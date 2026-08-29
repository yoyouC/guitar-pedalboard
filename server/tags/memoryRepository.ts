import type {
  ManagedMarketplaceTag,
  MarketplaceTagAdministrationRepository,
  MarketplaceTagAuditEntry,
} from './repository.ts';
import { MarketplaceTagConflictError, MarketplaceTagNotFoundError } from './repository.ts';

type StoredTag = Omit<ManagedMarketplaceTag, 'presetCount' | 'collectionCount'>;

export interface MemoryMarketplaceTagAdministrationBindings {
  presetTagIds(): ReadonlyMap<string, readonly string[]>;
  collectionTagIds(): ReadonlyMap<string, readonly string[]>;
  synchronizeTags(tags: readonly ManagedMarketplaceTag[]): void | Promise<void>;
}

export function createMemoryMarketplaceTagAdministrationRepository(input: {
  tags?: readonly StoredTag[];
  presetTagIds?: ReadonlyMap<string, readonly string[]>;
  collectionTagIds?: ReadonlyMap<string, readonly string[]>;
  bindings?: MemoryMarketplaceTagAdministrationBindings;
} = {}): MarketplaceTagAdministrationRepository {
  const tags = new Map((input.tags ?? []).map((tag) => [tag.id, structuredClone(tag)]));
  const presetTagIds = new Map([...input.presetTagIds ?? []].map(([id, tagIds]) => [id, [...tagIds]]));
  const collectionTagIds = new Map([...input.collectionTagIds ?? []].map(([id, tagIds]) => [id, [...tagIds]]));
  const audit: MarketplaceTagAuditEntry[] = [];
  const replaceAssignments = (
    target: Map<string, string[]>,
    source: ReadonlyMap<string, readonly string[]>,
  ) => {
    target.clear();
    for (const [id, tagIds] of source) target.set(id, [...tagIds]);
  };
  const refreshAssignments = () => {
    if (!input.bindings) return;
    replaceAssignments(presetTagIds, input.bindings.presetTagIds());
    replaceAssignments(collectionTagIds, input.bindings.collectionTagIds());
  };
  const present = (tag: StoredTag): ManagedMarketplaceTag => ({
    ...structuredClone(tag),
    presetCount: [...presetTagIds.values()].filter((ids) => ids.includes(tag.id)).length,
    collectionCount: [...collectionTagIds.values()].filter((ids) => ids.includes(tag.id)).length,
  });
  const managedTags = () => [...tags.values()]
    .sort((a, b) => a.dimension.localeCompare(b.dimension) || a.id.localeCompare(b.id))
    .map(present);
  const synchronize = async () => input.bindings?.synchronizeTags(managedTags());
  return {
    async list() {
      refreshAssignments();
      return managedTags();
    },
    async apply(command) {
      refreshAssignments();
      if (command.action === 'create') {
        if (tags.has(command.tag.id)) throw new MarketplaceTagConflictError();
        const tag: StoredTag = {
          ...structuredClone(command.tag), status: 'active', mergedIntoId: null,
        };
        tags.set(tag.id, tag);
        audit.push({
          id: command.auditId, actorAuthUserId: command.actorAuthUserId,
          action: 'create_tag', tagId: tag.id, targetTagId: null,
          reason: command.reason, createdAt: command.now.toISOString(),
        });
        await synchronize();
        return present(tag);
      }
      const current = tags.get(command.tagId);
      if (!current) throw new MarketplaceTagNotFoundError();
      if (command.action === 'merge') {
        if (current.status === 'merged') {
          if (current.mergedIntoId !== command.targetId) throw new MarketplaceTagConflictError();
          return present(current);
        }
        const target = tags.get(command.targetId);
        if (!target) throw new MarketplaceTagNotFoundError();
        if (target.id === current.id || target.status !== 'active') throw new MarketplaceTagConflictError();
        const aliasCandidates = [
          ...target.aliases, ...current.aliases, current.nameZh, current.nameEn, current.id,
        ];
        const seen = new Set<string>();
        target.aliases = aliasCandidates.filter((alias) => {
          const key = alias.normalize('NFKC').toLocaleLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        const migrate = (assignments: Map<string, string[]>) => assignments.forEach((ids, id) => {
          if (!ids.includes(current.id)) return;
          assignments.set(id, [...new Set(ids.map((tagId) => tagId === current.id ? target.id : tagId))]);
        });
        migrate(presetTagIds);
        migrate(collectionTagIds);
        for (const forwarded of tags.values()) {
          if (forwarded.mergedIntoId === current.id) forwarded.mergedIntoId = target.id;
        }
        const source: StoredTag = { ...current, status: 'merged', mergedIntoId: target.id };
        tags.set(source.id, source);
        tags.set(target.id, target);
        audit.push({
          id: command.auditId, actorAuthUserId: command.actorAuthUserId,
          action: 'merge_tag', tagId: source.id, targetTagId: target.id,
          reason: command.reason, createdAt: command.now.toISOString(),
        });
        await synchronize();
        return present(source);
      }
      if (current.status === 'merged') throw new MarketplaceTagConflictError();
      const tag: StoredTag = command.action === 'edit'
        ? { ...current, ...structuredClone(command.tag) }
        : { ...current, status: 'deprecated' };
      tags.set(tag.id, tag);
      audit.push({
        id: command.auditId, actorAuthUserId: command.actorAuthUserId,
        action: command.action === 'edit' ? 'edit_tag' : 'deprecate_tag',
        tagId: tag.id, targetTagId: null,
        reason: command.reason, createdAt: command.now.toISOString(),
      });
      await synchronize();
      return present(tag);
    },
    async listAudit() { return structuredClone(audit); },
  };
}
