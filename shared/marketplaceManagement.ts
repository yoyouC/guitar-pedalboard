import type {
  AppendPublishedPresetRevisionRequest,
  RestorePublishedPresetRevisionRequest,
  RigDerivedAttributes,
  RigResourceDependency,
  UpdatePublishedPresetMetadataRequest,
  UpdatePublishedPresetVisibilityRequest,
} from './marketplace.ts';
import { validatePublicationFields, type PublicationErrors } from './marketplacePublication.ts';
import {
  analyzePublishableRigAtSchema,
  isMarketplaceSchemaVersionSupported,
} from './publishableRig.ts';
import { RIG_PRESET_VERSION } from '../src/state/presetCodec.ts';
import { MARKETPLACE_SUPPORTED_SCHEMA_RANGE } from './marketplaceCompatibility.ts';

export type PresetManagementErrors = PublicationErrors & Partial<Record<
  'expectedUpdatedAt' | 'visibility',
  string
>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validExpectedUpdatedAt(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function validateMetadataUpdate(
  value: unknown,
  availableTagIds: ReadonlySet<string>,
): { value: UpdatePublishedPresetMetadataRequest | null; errors: PresetManagementErrors } {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, ['title', 'description', 'tagIds', 'expectedUpdatedAt'])
    || typeof value.title !== 'string'
    || typeof value.description !== 'string'
    || !Array.isArray(value.tagIds)
    || value.tagIds.some((tagId) => typeof tagId !== 'string')
  ) return { value: null, errors: { rig: '管理数据无效' } };

  const errors: PresetManagementErrors = validatePublicationFields({
    title: value.title,
    description: value.description,
    tagIds: value.tagIds as string[],
  });
  if ((value.tagIds as string[]).some((tagId) => !availableTagIds.has(tagId))) {
    errors.tagIds = '包含不可用标签';
  }
  if (!validExpectedUpdatedAt(value.expectedUpdatedAt)) {
    errors.expectedUpdatedAt = '并发版本无效';
  }
  if (Object.keys(errors).length > 0) return { value: null, errors };
  return {
    value: {
      title: value.title.trim(),
      description: value.description,
      tagIds: value.tagIds as string[],
      expectedUpdatedAt: value.expectedUpdatedAt as string,
    },
    errors: {},
  };
}

export interface ValidatedRevisionAppend {
  request: Omit<AppendPublishedPresetRevisionRequest, 'schemaVersion'> & {
    schemaVersion: typeof RIG_PRESET_VERSION;
  };
  resourceDependencies: RigResourceDependency[];
  derivedAttributes: RigDerivedAttributes;
}

export function validateRevisionAppend(
  value: unknown,
): { value: ValidatedRevisionAppend | null; errors: PresetManagementErrors } {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, ['schemaVersion', 'rig', 'expectedUpdatedAt'])
  ) return { value: null, errors: { rig: '修订数据无效' } };
  const errors: PresetManagementErrors = {};
  if (!validExpectedUpdatedAt(value.expectedUpdatedAt)) {
    errors.expectedUpdatedAt = '并发版本无效';
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
  if (!analysis || Object.keys(errors).length > 0) return { value: null, errors };
  return {
    value: {
      request: {
        schemaVersion: RIG_PRESET_VERSION,
        rig: analysis.rig,
        expectedUpdatedAt: value.expectedUpdatedAt as string,
      },
      resourceDependencies: analysis.resourceDependencies,
      derivedAttributes: analysis.derivedAttributes,
    },
    errors: {},
  };
}

export function validateRevisionRestore(
  value: unknown,
): RestorePublishedPresetRevisionRequest | null {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, ['expectedUpdatedAt'])
    || !validExpectedUpdatedAt(value.expectedUpdatedAt)
  ) return null;
  return { expectedUpdatedAt: value.expectedUpdatedAt };
}

export function validateVisibilityUpdate(
  value: unknown,
): UpdatePublishedPresetVisibilityRequest | null {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, ['visibility', 'expectedUpdatedAt'])
    || !['public', 'unlisted', 'withdrawn'].includes(String(value.visibility))
    || !validExpectedUpdatedAt(value.expectedUpdatedAt)
  ) return null;
  return {
    visibility: value.visibility as UpdatePublishedPresetVisibilityRequest['visibility'],
    expectedUpdatedAt: value.expectedUpdatedAt,
  };
}
