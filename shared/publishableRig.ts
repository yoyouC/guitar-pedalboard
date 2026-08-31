import type { RigPresetState } from '../src/state/presetCodec.js';
import {
  normalizeRig,
  normalizeRigPreset,
  RIG_PRESET_VERSION,
} from '../src/state/presetCodec.js';
import { MARKETPLACE_SUPPORTED_SCHEMA_RANGE } from './marketplaceCompatibility.js';
import { RIG_PRESET_CATALOG } from './rigPresetCatalog.js';
import type { RigDerivedAttributes, RigResourceDependency } from './marketplace.js';
import { rigResourceDependencyKey } from './marketplaceResource.js';

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

export function deriveRigResourceDependencies(rig: RigPresetState): RigResourceDependency[] {
  const dependencies = new Map<string, RigResourceDependency>();
  dependencies.set('builtin', { kind: 'builtin' });

  const addTone3000 = (modelRef: string, modelId?: string) => {
    const match = /^tone3000:(\d+)$/.exec(modelRef);
    if (!match) return;
    const dependency: RigResourceDependency = {
      kind: 'tone3000',
      toneId: match[1],
      ...(modelId ? { modelId } : {}),
    };
    dependencies.set(rigResourceDependencyKey(dependency), dependency);
  };

  addTone3000(rig.amp.modelKey, rig.amp.modelId);
  for (const item of rig.chain) {
    if (item.modelRef) addTone3000(item.modelRef, item.modelId);
  }
  return [...dependencies.values()];
}

export interface PublishableRigAnalysis {
  rig: RigPresetState;
  resourceDependencies: RigResourceDependency[];
  derivedAttributes: RigDerivedAttributes;
}

export function analyzePublishableRig(value: unknown): PublishableRigAnalysis | null {
  try {
    const rig = normalizeRig(value, RIG_PRESET_CATALOG);
    if (
      JSON.stringify(canonicalJsonValue(rig)) !== JSON.stringify(canonicalJsonValue(value))
      || rig.amp.modelKey === 'nam-wasm:custom'
      || rig.cab.ir.kind !== 'builtin'
    ) return null;

    const amp = RIG_PRESET_CATALOG.ampModels.find((model) => model.key === rig.amp.modelKey);
    const resourceDependencies = deriveRigResourceDependencies(rig);
    return {
      rig,
      resourceDependencies,
      derivedAttributes: {
        pedalIds: [...new Set(rig.chain.map((item) => item.effectId))].sort(),
        ampId: amp?.ampId ?? 'nam-wasm',
        ampModelKey: rig.amp.modelKey,
        cabId: rig.cab.id,
        resourceKinds: [...new Set(resourceDependencies.map((item) => item.kind))].sort(),
      },
    };
  } catch {
    return null;
  }
}

function isLosslessSubset(source: unknown, normalized: unknown): boolean {
  if (Array.isArray(source)) {
    return Array.isArray(normalized)
      && source.length === normalized.length
      && source.every((item, index) => isLosslessSubset(item, normalized[index]));
  }
  if (isRecord(source)) {
    return isRecord(normalized)
      && Object.entries(source).every(([key, item]) => (
        key in normalized && isLosslessSubset(item, normalized[key])
      ));
  }
  return Object.is(source, normalized);
}

export function isMarketplaceSchemaVersionSupported(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= MARKETPLACE_SUPPORTED_SCHEMA_RANGE.min
    && value <= MARKETPLACE_SUPPORTED_SCHEMA_RANGE.max;
}

/** Normalizes only migrations that preserve every field supplied by the old client. */
export function analyzePublishableRigAtSchema(
  schemaVersion: unknown,
  value: unknown,
): PublishableRigAnalysis | null {
  if (!isMarketplaceSchemaVersionSupported(schemaVersion)) return null;
  if (schemaVersion === RIG_PRESET_VERSION) return analyzePublishableRig(value);
  const migrated = normalizeRigPreset({
    version: schemaVersion,
    name: 'Marketplace schema migration',
    rig: value,
  }, RIG_PRESET_CATALOG);
  if (!migrated || !isLosslessSubset(value, migrated.rig)) return null;
  return analyzePublishableRig(migrated.rig);
}

export function sameResourceDependencies(
  left: readonly RigResourceDependency[],
  right: readonly RigResourceDependency[],
): boolean {
  const leftKeys = new Set(left.map(rigResourceDependencyKey));
  const rightKeys = new Set(right.map(rigResourceDependencyKey));
  return leftKeys.size === left.length
    && rightKeys.size === right.length
    && leftKeys.size === rightKeys.size
    && [...leftKeys].every((key) => rightKeys.has(key));
}
