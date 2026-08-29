import type { RigPresetState } from '../src/state/presetCodec.ts';
import { normalizeRig } from '../src/state/presetCodec.ts';
import { RIG_PRESET_CATALOG } from './rigPresetCatalog.ts';
import type { RigDerivedAttributes, RigResourceDependency } from './marketplace.ts';

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

function dependencyKey(dependency: RigResourceDependency): string {
  return dependency.kind === 'builtin'
    ? 'builtin'
    : `tone3000:${dependency.toneId}:${dependency.modelId ?? ''}`;
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
    dependencies.set(dependencyKey(dependency), dependency);
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

export function sameResourceDependencies(
  left: readonly RigResourceDependency[],
  right: readonly RigResourceDependency[],
): boolean {
  const leftKeys = new Set(left.map(dependencyKey));
  const rightKeys = new Set(right.map(dependencyKey));
  return leftKeys.size === left.length
    && rightKeys.size === right.length
    && leftKeys.size === rightKeys.size
    && [...leftKeys].every((key) => rightKeys.has(key));
}
