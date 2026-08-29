import type { PublishedPreset, RigResourceDependency } from './marketplace.ts';
import { RIG_PRESET_VERSION } from '../src/state/presetCodec.ts';
import {
  analyzePublishableRig,
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

function isLosslessPublishableCurrentRig(
  value: unknown,
  dependencies: RigResourceDependency[],
): boolean {
  const analysis = analyzePublishableRig(value);
  return Boolean(analysis && sameResourceDependencies(analysis.resourceDependencies, dependencies));
}

/** Published Preset 唯一可信入口：API 输出、未来写入与官方客户端共用。 */
export function parsePublicPublishedPreset(
  value: unknown,
  expectedId?: string,
): PublishedPreset | null {
  if (!isRecord(value) || !isRecord(value.creator) || !isRecord(value.currentRevision)) {
    return null;
  }
  const revision = value.currentRevision;
  const dependencies = revision.resourceDependencies;
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
    value.visibility === 'public' &&
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
    typeof revision.id === 'string' &&
    typeof revision.schemaVersion === 'number' &&
    typeof revision.createdAt === 'string' &&
    Array.isArray(dependencies) &&
    dependencies.length > 0 &&
    dependencies.every(isResourceDependency) &&
    isRecord(revision.rig) &&
    Array.isArray(revision.rig.chain) &&
    isRecord(revision.rig.amp) &&
    isRecord(revision.rig.cab) &&
    isRecord(revision.rig.preAmpEq) &&
    isRecord(revision.rig.globals)
  );
  if (!validEnvelope) return null;
  if (
    revision.schemaVersion === RIG_PRESET_VERSION &&
    !isLosslessPublishableCurrentRig(revision.rig, dependencies)
  ) {
    return null;
  }
  if (revision.schemaVersion === RIG_PRESET_VERSION) {
    const analysis = analyzePublishableRig(revision.rig);
    if (!analysis
      || !sameResourceDependencies(analysis.resourceDependencies, dependencies)
      || JSON.stringify(canonicalJsonValue(analysis.derivedAttributes))
        !== JSON.stringify(canonicalJsonValue(attributes))) return null;
  }
  return value as unknown as PublishedPreset;
}
