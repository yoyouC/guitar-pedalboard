import type { EffectDefinition, EffectInstance } from './types';
import { LEVEL_DB_MAX, LEVEL_DB_MIN, levelDbToGain } from '../level';

/**
 * Klon WDF ⚗:Klon Centaur 的 WDF 白盒电路建模版
 * (运放增益级 + 锗管对地削波 + GAIN 联动干湿混合 + Treble 高架)。
 * worklet 实现,加载失败兜底直通。
 */
export const klonWdfEffect: EffectDefinition = {
  id: 'klonwdf',
  name: 'Klon WDF ⚗',
  color: '#b8860b',
  params: [
    { key: 'gain', label: 'GAIN', min: 0, max: 100, step: 1, defaultValue: 30 },
    { key: 'treble', label: 'TREBLE', min: 0, max: 100, step: 1, defaultValue: 50 },
    { key: 'level', label: 'LEVEL', min: LEVEL_DB_MIN, max: LEVEL_DB_MAX, step: 0.5, defaultValue: 0, unit: 'dB' },
  ],
  create(ctx: AudioContext): EffectInstance {
    const input = ctx.createGain();
    const output = ctx.createGain();
    let node: AudioWorkletNode | null = null;
    try {
      node = new AudioWorkletNode(ctx, 'wdf-klon');
      input.connect(node);
      node.connect(output);
    } catch (e) {
      console.warn('Klon WDF worklet 未就绪,直通:', e);
      input.connect(output);
    }
    node?.parameters.get('level')?.setValueAtTime(1, ctx.currentTime);
    return {
      input,
      output,
      update(key, value) {
        const t = ctx.currentTime;
        if (key === 'level') {
          node?.parameters.get('level')?.setTargetAtTime(levelDbToGain(value), t, 0.03);
        } else {
          node?.parameters.get(key)?.setTargetAtTime(value, t, 0.03);
        }
      },
      dispose() {
        input.disconnect();
        node?.disconnect();
        output.disconnect();
      },
    };
  },
};
