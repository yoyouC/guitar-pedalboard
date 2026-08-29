import { Tone3000Error } from '../tone3000/client.ts';
import { tone3000 } from '../tone3000/instance.ts';
import type { Tone3000CompatibilityPort } from './revisionCompatibility.ts';

export const browserTone3000Compatibility: Tone3000CompatibilityPort = {
  isAuthenticated: () => tone3000.isAuthenticated(),
  async inspect(dependency) {
    if (dependency.modelId) {
      await tone3000.getModelInfo(dependency.toneId, dependency.modelId);
      return;
    }
    const models = await tone3000.listModels(dependency.toneId);
    if (models.length === 0) {
      throw new Tone3000Error('tone-unavailable', 'TONE3000 Tone 没有可用 NAM 模型');
    }
  },
};
