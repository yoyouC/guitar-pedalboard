import type {
  RigResourceDependency,
  RigResourceDependencyKey,
} from './marketplace.js';

export function rigResourceDependencyKey(
  dependency: RigResourceDependency,
): RigResourceDependencyKey {
  if (dependency.kind === 'builtin') return 'builtin';
  return `tone3000:${dependency.toneId}${dependency.modelId ? `:${dependency.modelId}` : ''}`;
}

export function parseRigResourceDependencyKey(value: string): RigResourceDependencyKey | null {
  return value === 'builtin' || /^tone3000:\d+(?::\d+)?$/.test(value)
    ? value as RigResourceDependencyKey
    : null;
}
