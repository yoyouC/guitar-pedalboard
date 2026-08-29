import type {
  CanonicalPublishedPresetRevision,
  PublishedPreset,
  PublishedPresetRevision,
  PublishedPresetRevisionView,
  PublishedPresetVisibility,
  RigDerivedAttributes,
  RigResourceDependency,
} from './marketplace.ts';
import {
  decodeCurrentRigPresetState,
  RIG_PRESET_VERSION,
  type RigPresetState,
} from '../src/state/presetCodec.ts';
import {
  analyzePublishableRig,
  deriveRigResourceDependencies,
  sameResourceDependencies,
} from './publishableRig.ts';

export { deriveRigResourceDependencies } from './publishableRig.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalJsonValue(value[key])]),
  );
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function textLength(value: string): number {
  return [...value].length;
}

function isResourceDependency(value: unknown): value is RigResourceDependency {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'builtin') return hasOnlyKeys(value, ['kind']);
  return (
    value.kind === 'tone3000' &&
    hasOnlyKeys(value, ['kind', 'toneId', 'modelId']) &&
    typeof value.toneId === 'string' &&
    /^\d+$/.test(value.toneId) &&
    (value.modelId === undefined || (typeof value.modelId === 'string' && /^\d+$/.test(value.modelId)))
  );
}

function isMarketplaceTag(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return hasOnlyKeys(value, ['id', 'dimension', 'nameZh', 'nameEn'])
    && typeof value.id === 'string'
    && typeof value.dimension === 'string'
    && typeof value.nameZh === 'string'
    && typeof value.nameEn === 'string';
}

function isPublishedPresetSource(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.creator)) return false;
  return hasOnlyKeys(value, [
    'presetId',
    'revisionId',
    'creator',
    'availability',
    'title',
  ])
    && typeof value.presetId === 'string'
    && value.presetId.length > 0
    && typeof value.revisionId === 'string'
    && value.revisionId.length > 0
    && hasOnlyKeys(value.creator, ['id', 'handle', 'displayName'])
    && typeof value.creator.id === 'string'
    && typeof value.creator.handle === 'string'
    && typeof value.creator.displayName === 'string'
    && (value.availability === 'available' || value.availability === 'unavailable')
    && (value.availability === 'available'
      ? typeof value.title === 'string' && value.title.length > 0
      : value.title === null);
}

function isDerivedAttributes(value: unknown): value is RigDerivedAttributes {
  return isRecord(value)
    && hasOnlyKeys(value, ['pedalIds', 'ampId', 'ampModelKey', 'cabId', 'resourceKinds'])
    && Array.isArray(value.pedalIds)
    && value.pedalIds.every((id) => typeof id === 'string' && id.length > 0)
    && typeof value.ampId === 'string'
    && value.ampId.length > 0
    && typeof value.ampModelKey === 'string'
    && value.ampModelKey.length > 0
    && typeof value.cabId === 'string'
    && value.cabId.length > 0
    && Array.isArray(value.resourceKinds)
    && value.resourceKinds.every((kind) => kind === 'builtin' || kind === 'tone3000');
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJsonValue(left)) === JSON.stringify(canonicalJsonValue(right));
}

function isConsistentStoredCurrentRevision(
  rig: RigPresetState,
  dependencies: RigResourceDependency[],
  attributes: RigDerivedAttributes,
): boolean {
  const derivedDependencies = deriveRigResourceDependencies(rig);
  return rig.amp.modelKey !== 'nam-wasm:custom'
    && rig.cab.ir.kind === 'builtin'
    && sameResourceDependencies(derivedDependencies, dependencies)
    && sameJson(attributes.pedalIds, [...new Set(rig.chain.map((item) => item.effectId))].sort())
    && attributes.ampModelKey === rig.amp.modelKey
    && attributes.cabId === rig.cab.id
    && sameJson(
      attributes.resourceKinds,
      [...new Set(derivedDependencies.map((item) => item.kind))].sort(),
    );
}

export function isValidStoredPublishedPresetRevision(
  value: unknown,
): value is PublishedPresetRevision {
  if (!isRecord(value)) return false;
  const dependencies = value.resourceDependencies;
  const attributes = value.derivedAttributes;
  const validEnvelope = (
    typeof value.id === 'string'
    && typeof value.schemaVersion === 'number'
    && (value.payloadKind === 'canonical-rig' || value.payloadKind === 'opaque')
    && typeof value.createdAt === 'string'
    && Array.isArray(dependencies)
    && dependencies.length > 0
    && dependencies.every(isResourceDependency)
    && isDerivedAttributes(attributes)
    && isRecord(value.rig)
  );
  if (!validEnvelope) return false;
  if (value.schemaVersion !== RIG_PRESET_VERSION) return value.payloadKind === 'opaque';
  if (value.payloadKind !== 'canonical-rig') return false;
  const rig = decodeCurrentRigPresetState(value.rig);
  return Boolean(rig && isConsistentStoredCurrentRevision(rig, dependencies, attributes));
}

export function isPublishedPresetRevisionCompatible(
  revision: PublishedPresetRevision,
): revision is CanonicalPublishedPresetRevision {
  if (revision.payloadKind !== 'canonical-rig' || revision.schemaVersion !== RIG_PRESET_VERSION) {
    return false;
  }
  const analysis = analyzePublishableRig(revision.rig);
  return Boolean(
    analysis
    && sameResourceDependencies(analysis.resourceDependencies, revision.resourceDependencies)
    && sameJson(analysis.derivedAttributes, revision.derivedAttributes),
  );
}

function parsePublishedPreset(
  value: unknown,
  expectedId: string | undefined,
  allowedVisibilities: readonly PublishedPresetVisibility[],
): PublishedPreset | null {
  if (!isRecord(value) || !isRecord(value.creator) || !isRecord(value.currentRevision)) {
    return null;
  }
  const revision = value.currentRevision;
  const attributes = value.derivedAttributes;
  const validEnvelope = (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    (expectedId === undefined || value.id === expectedId) &&
    typeof value.title === 'string' &&
    textLength(value.title) > 0 &&
    textLength(value.title) <= 80 &&
    typeof value.description === 'string' &&
    textLength(value.description) <= 2_000 &&
    allowedVisibilities.includes(value.visibility as PublishedPresetVisibility) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    typeof value.creator.id === 'string' &&
    typeof value.creator.handle === 'string' &&
    typeof value.creator.displayName === 'string' &&
    Array.isArray(value.tags) &&
    value.tags.length >= 1 &&
    value.tags.length <= 5 &&
    value.tags.every(isMarketplaceTag) &&
    isRecord(attributes) &&
    hasOnlyKeys(attributes, ['pedalIds', 'ampId', 'ampModelKey', 'cabId', 'resourceKinds']) &&
    Array.isArray(attributes.pedalIds) &&
    attributes.pedalIds.every((id) => typeof id === 'string') &&
    typeof attributes.ampId === 'string' &&
    typeof attributes.ampModelKey === 'string' &&
    typeof attributes.cabId === 'string' &&
    Array.isArray(attributes.resourceKinds) &&
    attributes.resourceKinds.every((kind) => kind === 'builtin' || kind === 'tone3000') &&
    isValidStoredPublishedPresetRevision(revision)
    && (value.source === undefined || isPublishedPresetSource(value.source))
  );
  if (!validEnvelope) return null;
  if (!sameJson(revision.derivedAttributes, attributes)) return null;
  return value as unknown as PublishedPreset;
}

/** Published Preset 唯一可信入口：API 输出、未来写入与官方客户端共用。 */
export function parsePublicPublishedPreset(
  value: unknown,
  expectedId?: string,
): PublishedPreset | null {
  return parsePublishedPreset(value, expectedId, ['public', 'unlisted']);
}

export function parseManagedPublishedPreset(
  value: unknown,
  expectedId?: string,
): PublishedPreset | null {
  return parsePublishedPreset(value, expectedId, ['public', 'unlisted', 'withdrawn']);
}

export function parsePublishedPresetRevisionView(
  value: unknown,
  expectedPresetId?: string,
  expectedRevisionId?: string,
): PublishedPresetRevisionView | null {
  if (!isRecord(value) || !isRecord(value.creator) || !isValidStoredPublishedPresetRevision(value.revision)) {
    return null;
  }
  if (
    typeof value.id !== 'string'
    || value.id.length < 1
    || (expectedPresetId !== undefined && value.id !== expectedPresetId)
    || typeof value.title !== 'string'
    || textLength(value.title) < 1
    || textLength(value.title) > 80
    || typeof value.description !== 'string'
    || textLength(value.description) > 2_000
    || (value.visibility !== 'public' && value.visibility !== 'unlisted')
    || typeof value.currentRevisionId !== 'string'
    || typeof value.createdAt !== 'string'
    || typeof value.updatedAt !== 'string'
    || typeof value.creator.id !== 'string'
    || typeof value.creator.handle !== 'string'
    || typeof value.creator.displayName !== 'string'
    || !Array.isArray(value.tags)
    || value.tags.length < 1
    || value.tags.length > 5
    || !value.tags.every(isMarketplaceTag)
    || (expectedRevisionId !== undefined && value.revision.id !== expectedRevisionId)
    || (value.source !== undefined && !isPublishedPresetSource(value.source))
  ) return null;
  return value as unknown as PublishedPresetRevisionView;
}
