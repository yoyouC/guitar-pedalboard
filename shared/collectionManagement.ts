import type {
  CreatePresetCollectionRequest,
  PresetCollectionReference,
  UpdatePresetCollectionRequest,
} from './marketplace.js';
import { validatePublicationFields } from './marketplacePublication.js';

export type CollectionField =
  | 'title'
  | 'description'
  | 'tagIds'
  | 'visibility'
  | 'items'
  | 'expectedUpdatedAt';
export type CollectionErrors = Partial<Record<CollectionField, string>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function commonFields(
  value: Record<string, unknown>,
  availableTagIds: ReadonlySet<string>,
): { title: string; description: string; tagIds: string[]; errors: CollectionErrors } | null {
  if (
    typeof value.title !== 'string'
    || typeof value.description !== 'string'
    || !Array.isArray(value.tagIds)
    || value.tagIds.some((tagId) => typeof tagId !== 'string')
  ) return null;
  const tagIds = value.tagIds as string[];
  const errors: CollectionErrors = validatePublicationFields({
    title: value.title,
    description: value.description,
    tagIds,
  });
  if (tagIds.some((tagId) => !availableTagIds.has(tagId))) {
    errors.tagIds = '包含不可用标签';
  }
  return {
    title: value.title.trim(),
    description: value.description,
    tagIds,
    errors,
  };
}

export function validateCreatePresetCollection(
  value: unknown,
  availableTagIds: ReadonlySet<string>,
): { value: CreatePresetCollectionRequest | null; errors: CollectionErrors } {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, ['title', 'description', 'tagIds', 'visibility'])
  ) return { value: null, errors: { title: '合集数据无效' } };
  const common = commonFields(value, availableTagIds);
  if (!common) return { value: null, errors: { title: '合集数据无效' } };
  if (value.visibility !== 'public' && value.visibility !== 'unlisted') {
    common.errors.visibility = '可见性无效';
  }
  if (Object.keys(common.errors).length > 0) return { value: null, errors: common.errors };
  return {
    value: {
      title: common.title,
      description: common.description,
      tagIds: common.tagIds,
      visibility: value.visibility as CreatePresetCollectionRequest['visibility'],
    },
    errors: {},
  };
}

function parseReference(value: unknown): PresetCollectionReference | null {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, ['presetId', 'revisionId'])
    || typeof value.presetId !== 'string'
    || !value.presetId
    || typeof value.revisionId !== 'string'
    || !value.revisionId
  ) return null;
  return { presetId: value.presetId, revisionId: value.revisionId };
}

export function validateUpdatePresetCollection(
  value: unknown,
  availableTagIds: ReadonlySet<string>,
): { value: UpdatePresetCollectionRequest | null; errors: CollectionErrors } {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, [
      'title', 'description', 'tagIds', 'visibility', 'items', 'expectedUpdatedAt',
    ])
  ) return { value: null, errors: { title: '合集数据无效' } };
  const common = commonFields(value, availableTagIds);
  if (!common) return { value: null, errors: { title: '合集数据无效' } };
  if (!['public', 'unlisted', 'withdrawn'].includes(String(value.visibility))) {
    common.errors.visibility = '可见性无效';
  }
  if (!Array.isArray(value.items)) {
    common.errors.items = '合集条目无效';
  }
  const items = Array.isArray(value.items) ? value.items.map(parseReference) : [];
  if (items.some((item) => !item)) common.errors.items = '合集条目无效';
  const validItems = items.filter((item): item is PresetCollectionReference => item !== null);
  const keys = validItems.map((item) => `${item.presetId}\u0000${item.revisionId}`);
  if (new Set(keys).size !== keys.length) common.errors.items = '合集条目不能重复';
  if (
    typeof value.expectedUpdatedAt !== 'string'
    || !Number.isFinite(Date.parse(value.expectedUpdatedAt))
  ) common.errors.expectedUpdatedAt = '并发令牌无效';
  if (Object.keys(common.errors).length > 0) return { value: null, errors: common.errors };
  return {
    value: {
      title: common.title,
      description: common.description,
      tagIds: common.tagIds,
      visibility: value.visibility as UpdatePresetCollectionRequest['visibility'],
      items: validItems,
      expectedUpdatedAt: value.expectedUpdatedAt as string,
    },
    errors: {},
  };
}
