import type {
  PublishedPresetCompatibilityBlocker,
  PublishedPresetRevision,
  PublishedPresetRevisionCompatibility,
  Tone3000DependencyFact,
} from './marketplace.ts';
import { rigResourceDependencyKey } from './marketplaceResource.ts';
import { RIG_PRESET_CATALOG } from './rigPresetCatalog.ts';
import { RIG_PRESET_VERSION } from '../src/state/presetCodec.ts';

export const MARKETPLACE_SUPPORTED_SCHEMA_RANGE = {
  min: 2,
  max: RIG_PRESET_VERSION,
} as const;

function schemaBlocker(schemaVersion: number): PublishedPresetCompatibilityBlocker {
  return {
    kind: 'schema-version',
    schemaVersion,
    supportedMin: MARKETPLACE_SUPPORTED_SCHEMA_RANGE.min,
    supportedMax: MARKETPLACE_SUPPORTED_SCHEMA_RANGE.max,
  };
}

export function evaluatePublishedPresetRevisionCompatibility(
  revision: PublishedPresetRevision,
  tone3000Facts: readonly Tone3000DependencyFact[] = [],
): PublishedPresetRevisionCompatibility {
  const blockers: PublishedPresetCompatibilityBlocker[] = [];
  if (revision.payloadKind !== 'canonical-rig' || revision.schemaVersion !== RIG_PRESET_VERSION) {
    return { status: 'incompatible', blockers: [schemaBlocker(revision.schemaVersion)] };
  }

  const knownPedals = new Set(RIG_PRESET_CATALOG.effects.map((effect) => effect.id));
  for (const pedalId of new Set(revision.rig.chain.map((item) => item.effectId))) {
    if (!knownPedals.has(pedalId)) {
      blockers.push({ kind: 'catalog-item', equipmentKind: 'pedal', id: pedalId });
    }
  }

  const ampKey = revision.rig.amp.modelKey;
  if (!ampKey.startsWith('tone3000:')
    && !RIG_PRESET_CATALOG.ampModels.some((model) => model.key === ampKey)) {
    blockers.push({ kind: 'catalog-item', equipmentKind: 'amp', id: ampKey });
  }
  if (!RIG_PRESET_CATALOG.cabs.some((cab) => cab.id === revision.rig.cab.id)) {
    blockers.push({ kind: 'catalog-item', equipmentKind: 'cab', id: revision.rig.cab.id });
  }

  const facts = new Map(tone3000Facts.map((fact) => [fact.dependencyKey, fact]));
  for (const dependency of revision.resourceDependencies) {
    if (dependency.kind !== 'tone3000') continue;
    const dependencyKey = rigResourceDependencyKey(dependency) as `tone3000:${string}`;
    const fact = facts.get(dependencyKey);
    const availability = fact?.availability ?? 'unknown';
    if (availability !== 'available') {
      blockers.push({
        kind: 'tone3000',
        dependencyKey,
        availability,
        ...(fact?.reason ? { reason: fact.reason } : { reason: 'not-checked' }),
      });
    }
  }

  if (blockers.some((blocker) => (
    blocker.kind !== 'tone3000' || blocker.availability !== 'authorization-required'
  ))) {
    return { status: 'incompatible', blockers };
  }
  return blockers.length > 0
    ? { status: 'authorization-required', blockers }
    : { status: 'compatible', blockers: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function parsePublishedPresetRevisionCompatibility(
  value: unknown,
): PublishedPresetRevisionCompatibility | null {
  if (!isRecord(value)
    || !['compatible', 'authorization-required', 'incompatible'].includes(String(value.status))
    || !Array.isArray(value.blockers)) return null;
  for (const blocker of value.blockers) {
    if (!isRecord(blocker) || typeof blocker.kind !== 'string') return null;
    if (blocker.kind === 'schema-version') {
      if (!hasOnlyKeys(blocker, ['kind', 'schemaVersion', 'supportedMin', 'supportedMax'])) return null;
      if (![blocker.schemaVersion, blocker.supportedMin, blocker.supportedMax]
        .every((item) => typeof item === 'number' && Number.isInteger(item))) return null;
      continue;
    }
    if (blocker.kind === 'catalog-item') {
      if (!hasOnlyKeys(blocker, ['kind', 'equipmentKind', 'id'])) return null;
      if (!['pedal', 'amp', 'cab'].includes(String(blocker.equipmentKind))
        || typeof blocker.id !== 'string' || !blocker.id) return null;
      continue;
    }
    if (blocker.kind === 'tone3000') {
      if (!hasOnlyKeys(blocker, ['kind', 'dependencyKey', 'availability', 'reason'])) return null;
      if (typeof blocker.dependencyKey !== 'string'
        || !/^tone3000:\d+(?::\d+)?$/.test(blocker.dependencyKey)
        || !['authorization-required', 'unavailable', 'unknown'].includes(String(blocker.availability))
        || (blocker.reason !== undefined
          && !['deleted', 'private', 'license-revoked', 'not-checked'].includes(String(blocker.reason)))) {
        return null;
      }
      continue;
    }
    return null;
  }
  if (value.status === 'compatible' && value.blockers.length !== 0) return null;
  if (value.status === 'incompatible' && value.blockers.length === 0) return null;
  if (value.status === 'authorization-required' && value.blockers.some((blocker) => (
    !isRecord(blocker)
    || blocker.kind !== 'tone3000'
    || blocker.availability !== 'authorization-required'
  ))) return null;
  return value as unknown as PublishedPresetRevisionCompatibility;
}
