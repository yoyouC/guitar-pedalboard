import type { PublishedPreset, RigResourceDependency } from './marketplace.ts';
import type { RigPresetState } from '../src/state/presetCodec.ts';
import { normalizeRig, RIG_PRESET_VERSION } from '../src/state/presetCodec.ts';
import { RIG_PRESET_CATALOG } from '../src/state/store.ts';

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

function hasExactResourceDependencies(
  rig: RigPresetState,
  dependencies: RigResourceDependency[],
): boolean {
  const provided = new Set(dependencies.map(dependencyKey));
  const derived = new Set(deriveRigResourceDependencies(rig).map(dependencyKey));
  return (
    provided.size === dependencies.length &&
    provided.size === derived.size &&
    [...provided].every((key) => derived.has(key))
  );
}

function isLosslessPublishableCurrentRig(
  value: unknown,
  dependencies: RigResourceDependency[],
): value is RigPresetState {
  try {
    const normalized = normalizeRig(value, RIG_PRESET_CATALOG);
    return (
      normalized.cab.ir.kind === 'builtin' &&
      normalized.amp.modelKey !== 'nam-wasm:custom' &&
      JSON.stringify(canonicalJsonValue(normalized)) === JSON.stringify(canonicalJsonValue(value)) &&
      hasExactResourceDependencies(normalized, dependencies)
    );
  } catch {
    return false;
  }
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
  const validEnvelope = (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    (expectedId === undefined || value.id === expectedId) &&
    typeof value.title === 'string' &&
    value.title.length > 0 &&
    value.title.length <= 80 &&
    typeof value.description === 'string' &&
    value.description.length <= 2_000 &&
    value.visibility === 'public' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    typeof value.creator.id === 'string' &&
    typeof value.creator.handle === 'string' &&
    typeof value.creator.displayName === 'string' &&
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
  return value as unknown as PublishedPreset;
}
