import type { EffectDefinition, EffectInstance } from './types';
import { LEVEL_DB_MAX, LEVEL_DB_MIN, levelDbToGain } from '../level';

/**
 * RAT WDF ⚗:与内置 rat(双二阶+波形表近似)并存的 WDF 精确电路建模版。
 * 可变增益运放 + 1N914 对地硬削波 + 反向 FILTER,worklet 实现,加载失败兜底直通。
 */
export const ratWdfEffect: EffectDefinition = {
  id: 'ratwdf',
  name: 'RAT WDF ⚗',
  color: '#26262a',
  params: [
    { key: 'drive', label: 'DIST', min: 0, max: 100, step: 1, defaultValue: 55 },
    { key: 'filter', label: 'FILTER', min: 0, max: 100, step: 1, defaultValue: 35 },
    { key: 'level', label: 'LEVEL', min: LEVEL_DB_MIN, max: LEVEL_DB_MAX, step: 0.5, defaultValue: 0, unit: 'dB' },
  ],
  create(ctx: AudioContext): EffectInstance {
    const input = ctx.createGain();
    const output = ctx.createGain();
    let node: AudioWorkletNode | null = null;
    try {
      node = new AudioWorkletNode(ctx, 'wdf-rat');
      input.connect(node);
      node.connect(output);
    } catch (e) {
      console.warn('RAT WDF worklet 未就绪,直通:', e);
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
