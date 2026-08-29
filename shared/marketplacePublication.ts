import type {
  PublishPresetRequest,
  RigDerivedAttributes,
  RigResourceDependency,
} from './marketplace.ts';
import type { RigPresetState } from '../src/state/presetCodec.ts';
import { RIG_PRESET_VERSION } from '../src/state/presetCodec.ts';
import {
  analyzePublishableRigAtSchema,
  isMarketplaceSchemaVersionSupported,
} from './publishableRig.ts';
import { MARKETPLACE_SUPPORTED_SCHEMA_RANGE } from './marketplaceCompatibility.ts';

export type PublicationField = 'title' | 'description' | 'tagIds' | 'rig' | 'source';
export type PublicationErrors = Partial<Record<PublicationField, string>>;

export interface ValidatedPublication {
  request: Omit<PublishPresetRequest, 'schemaVersion'> & {
    schemaVersion: typeof RIG_PRESET_VERSION;
  };
  resourceDependencies: RigResourceDependency[];
  derivedAttributes: RigDerivedAttributes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textLength(value: string): number {
  return [...value].length;
}

export function validatePublicationFields(input: {
  title: string;
  description: string;
  tagIds: readonly string[];
}): PublicationErrors {
  const errors: PublicationErrors = {};
  if (!input.title.trim()) errors.title = '标题不能为空';
  else if (textLength(input.title) > 80) errors.title = '标题最多 80 个字符';
  if (textLength(input.description) > 2_000) errors.description = '介绍最多 2,000 个字符';
  if (input.tagIds.length < 1 || input.tagIds.length > 5) {
    errors.tagIds = '请选择 1–5 个标签';
  } else if (new Set(input.tagIds).size !== input.tagIds.length) {
    errors.tagIds = '标签不能重复';
  }
  return errors;
}

export function validatePublishPresetRequest(
  value: unknown,
  availableTagIds: ReadonlySet<string>,
): { value: ValidatedPublication | null; errors: PublicationErrors } {
  if (!isRecord(value)) return { value: null, errors: { rig: '发布数据无效' } };
  const allowedKeys = ['title', 'description', 'tagIds', 'schemaVersion', 'rig', 'source'];
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    return { value: null, errors: { rig: '发布数据包含不允许的字段' } };
  }
  if (
    typeof value.title !== 'string'
    || typeof value.description !== 'string'
    || !Array.isArray(value.tagIds)
    || value.tagIds.some((tagId) => typeof tagId !== 'string')
  ) return { value: null, errors: { rig: '发布数据无效' } };

  let source: PublishPresetRequest['source'];
  if (value.source !== undefined) {
    if (
      !isRecord(value.source)
      || Object.keys(value.source).some((key) => !['presetId', 'revisionId'].includes(key))
      || typeof value.source.presetId !== 'string'
      || !value.source.presetId
      || typeof value.source.revisionId !== 'string'
      || !value.source.revisionId
    ) return { value: null, errors: { source: '来源关系无效' } };
    source = {
      presetId: value.source.presetId,
      revisionId: value.source.revisionId,
    };
  }

  const errors = validatePublicationFields({
    title: value.title,
    description: value.description,
    tagIds: value.tagIds as string[],
  });
  if ((value.tagIds as string[]).some((tagId) => !availableTagIds.has(tagId))) {
    errors.tagIds = '包含不可用标签';
  }
  if (!isMarketplaceSchemaVersionSupported(value.schemaVersion)) {
    errors.rig = `Rig 版本不受支持（支持 ${MARKETPLACE_SUPPORTED_SCHEMA_RANGE.min}–${MARKETPLACE_SUPPORTED_SCHEMA_RANGE.max}），请升级客户端`;
  }
  const analysis = analyzePublishableRigAtSchema(value.schemaVersion, value.rig);
  if (!analysis && !errors.rig) {
    errors.rig = value.schemaVersion === RIG_PRESET_VERSION
      ? 'Rig 无法无损发布或包含本机资源'
      : '旧版 Rig 无法无损迁移，请升级客户端后发布';
  }
  if (Object.keys(errors).length > 0 || !analysis) return { value: null, errors };

  return {
    value: {
      request: {
        title: value.title.trim(),
        description: value.description,
        tagIds: value.tagIds as string[],
        schemaVersion: RIG_PRESET_VERSION,
        rig: analysis.rig as RigPresetState,
        ...(source ? { source } : {}),
      },
      resourceDependencies: analysis.resourceDependencies,
      derivedAttributes: analysis.derivedAttributes,
    },
    errors: {},
  };
}
