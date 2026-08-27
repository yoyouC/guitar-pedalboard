import type { Tone3000ModelArchitecture, Tone3000ModelInfo } from './client';

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
