import type {
  PublishedPresetRevision,
  PublishedPresetRevisionCompatibility,
  RigResourceDependency,
  Tone3000DependencyFact,
} from '../../shared/marketplace.ts';
import { evaluatePublishedPresetRevisionCompatibility } from '../../shared/marketplaceCompatibility.ts';
import { rigResourceDependencyKey } from '../../shared/marketplaceResource.ts';
import { Tone3000Error } from '../tone3000/client.ts';

export interface Tone3000CompatibilityPort {
  isAuthenticated(): boolean;
  inspect(dependency: Extract<RigResourceDependency, { kind: 'tone3000' }>): Promise<void>;
}

export async function resolvePublishedRevisionCompatibility(
  revision: PublishedPresetRevision,
  port: Tone3000CompatibilityPort,
): Promise<PublishedPresetRevisionCompatibility> {
  const dependencies = revision.resourceDependencies.filter(
    (item): item is Extract<RigResourceDependency, { kind: 'tone3000' }> => item.kind === 'tone3000',
  );
  if (dependencies.length === 0) {
    return evaluatePublishedPresetRevisionCompatibility(revision);
  }
  if (!port.isAuthenticated()) {
    return evaluatePublishedPresetRevisionCompatibility(revision, dependencies.map((dependency) => ({
      dependencyKey: rigResourceDependencyKey(dependency) as `tone3000:${string}`,
      availability: 'authorization-required',
    })));
  }

  const facts: Tone3000DependencyFact[] = await Promise.all(dependencies.map(async (dependency) => {
    const dependencyKey = rigResourceDependencyKey(dependency) as `tone3000:${string}`;
    try {
      await port.inspect(dependency);
      return { dependencyKey, availability: 'available' };
    } catch (cause) {
      if (cause instanceof Tone3000Error) {
        if (cause.reason === 'not-authenticated') {
          return { dependencyKey, availability: 'authorization-required' };
        }
        if (cause.reason === 'tone-unavailable') {
          return {
            dependencyKey,
            availability: 'unavailable',
            ...(cause.status === 404
              ? { reason: 'deleted' as const }
              : cause.status === 403
                ? { reason: 'private' as const }
                : {}),
          };
        }
      }
      return { dependencyKey, availability: 'unknown', reason: 'not-checked' };
    }
  }));
  return evaluatePublishedPresetRevisionCompatibility(revision, facts);
}

export function compatibilityBlockerMessage(
  blocker: PublishedPresetRevisionCompatibility['blockers'][number],
): string {
  if (blocker.kind === 'schema-version') {
    return `Rig schema ${blocker.schemaVersion} 超出当前支持范围 ${blocker.supportedMin}–${blocker.supportedMax}`;
  }
  if (blocker.kind === 'catalog-item') {
    const label = blocker.equipmentKind === 'pedal' ? 'Pedal' : blocker.equipmentKind === 'amp' ? 'Amp' : 'Cab';
    return `${label} ${blocker.id} 已不在当前器材目录中`;
  }
  if (blocker.availability === 'authorization-required') {
    return `${blocker.dependencyKey} 需要连接 TONE3000`;
  }
  if (blocker.availability === 'unknown') {
    return `${blocker.dependencyKey} 暂时无法验证`;
  }
  const reason = blocker.reason === 'deleted'
    ? '已删除'
    : blocker.reason === 'private'
      ? '已转为私有或无访问权'
      : blocker.reason === 'license-revoked'
        ? '许可已失效'
        : '不可用';
  return `${blocker.dependencyKey} ${reason}`;
}
