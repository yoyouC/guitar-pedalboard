import type { Tone3000ModelArchitecture, Tone3000ModelInfo } from './client';

const DEFAULT_ARCHITECTURE_ORDER: Tone3000ModelArchitecture[] = ['2', '1', 'custom'];

export interface Tone3000ModelVariantFilters {
  query: string;
  architecture: 'all' | Tone3000ModelArchitecture;
  size: string;
}

export function tone3000ModelVariantLabel(modelVariant: Tone3000ModelInfo): string {
  return modelVariant.name || `采样 #${modelVariant.id}`;
}

export function filterTone3000ModelVariants(
  modelVariants: Tone3000ModelInfo[],
  filters: Tone3000ModelVariantFilters,
): Tone3000ModelInfo[] {
  const normalizedQuery = filters.query.trim().toLocaleLowerCase();
  return modelVariants.filter((modelVariant) => {
    if (
      filters.architecture !== 'all' &&
      modelVariant.architecture !== filters.architecture
    ) {
      return false;
    }
    if (filters.size !== 'all' && modelVariant.size !== filters.size) return false;
    return (
      !normalizedQuery ||
      tone3000ModelVariantLabel(modelVariant)
        .toLocaleLowerCase()
        .includes(normalizedQuery) ||
      modelVariant.id.includes(normalizedQuery)
    );
  });
}

export function orderTone3000ModelVariantArchitectures(
  modelVariants: Tone3000ModelInfo[],
  currentModelId?: string,
): Tone3000ModelArchitecture[] {
  const currentArchitecture = modelVariants.find(
    (modelVariant) => modelVariant.id === currentModelId,
  )?.architecture;
  return currentArchitecture
    ? [
        currentArchitecture,
        ...DEFAULT_ARCHITECTURE_ORDER.filter(
          (architecture) => architecture !== currentArchitecture,
        ),
      ]
    : [...DEFAULT_ARCHITECTURE_ORDER];
}
