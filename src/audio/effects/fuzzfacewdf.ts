import type { EffectDefinition, EffectInstance } from './types';
import { LEVEL_DB_MAX, LEVEL_DB_MIN, levelDbToGain } from '../level';

/**
 * Fuzz Face WDF ⚗:经典两级锗管法兹的白盒电路建模(简化 Ebers-Moll 双 BJT,
 * 100k 电压反馈偏置,4x 过采样)。worklet 实现,加载失败兜底直通。
 */
export const fuzzfaceWdfEffect: EffectDefinition = {
  id: 'fuzzfacewdf',
  name: 'Fuzz Face WDF ⚗',
  color: '#a93226',
  params: [
    { key: 'fuzz', label: 'FUZZ', min: 0, max: 100, step: 1, defaultValue: 70 },
    { key: 'level', label: 'LEVEL', min: LEVEL_DB_MIN, max: LEVEL_DB_MAX, step: 0.5, defaultValue: 0, unit: 'dB' },
  ],
  create(ctx: AudioContext): EffectInstance {
    const input = ctx.createGain();
    const output = ctx.createGain();
    let node: AudioWorkletNode | null = null;
    try {
      node = new AudioWorkletNode(ctx, 'wdf-fuzzface');
      input.connect(node);
      node.connect(output);
    } catch (e) {
      console.warn('Fuzz Face WDF worklet 未就绪,直通:', e);
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
