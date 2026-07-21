import type { EffectDefinition, EffectInstance } from './types';
import { LEVEL_DB_MAX, LEVEL_DB_MIN, levelDbToGain } from '../level';

/**
 * TS808 WDF ⚗:与内置 ts808(双二阶近似)并存的 WDF 精确电路建模版。
 * worklet 实现,加载失败兜底直通。
 */
export const ts808WdfEffect: EffectDefinition = {
  id: 'ts808wdf',
  name: 'TS808 WDF ⚗',
  color: '#1f6e43',
  params: [
    { key: 'drive', label: 'DRIVE', min: 0, max: 100, step: 1, defaultValue: 45 },
    { key: 'tone', label: 'TONE', min: 0, max: 100, step: 1, defaultValue: 55 },
    { key: 'level', label: 'LEVEL', min: LEVEL_DB_MIN, max: LEVEL_DB_MAX, step: 0.5, defaultValue: 0, unit: 'dB' },
  ],
  create(ctx: AudioContext): EffectInstance {
    const input = ctx.createGain();
    const output = ctx.createGain();
    let node: AudioWorkletNode | null = null;
    try {
      node = new AudioWorkletNode(ctx, 'wdf-ts808');
      input.connect(node);
      node.connect(output);
    } catch (e) {
      console.warn('TS808 WDF worklet 未就绪,直通:', e);
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
