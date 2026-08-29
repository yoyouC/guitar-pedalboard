import type { PublishedPreset } from '../../shared/marketplace.ts';
import type { PublishedPresetRepository } from './repository.ts';

export function createMemoryPublishedPresetRepository(
  presets: readonly PublishedPreset[] = [],
): PublishedPresetRepository {
  const presetsById = new Map(presets.map((preset) => [preset.id, preset]));

  return {
    async findPublicById(id) {
      const preset = presetsById.get(id);
      return preset?.visibility === 'public' ? preset : null;
    },
  };
}
