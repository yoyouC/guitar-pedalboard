import type { PublishedPreset } from '../../shared/marketplace.ts';

export interface PublishedPresetRepository {
  findPublicById(id: string): Promise<PublishedPreset | null>;
}
