import type { EffectDefinition, EffectInstance } from './types';
import { dbToGain } from '../level';

/**
 * LA-2A 光学压缩 ⚗:T4B 光电池白盒建模(软拐点 + 程序相关两段式释放)。
 * worklet 实现('opto-la2a'),加载失败兜底直通。
 */
export const la2aEffect: EffectDefinition = {
  id: 'la2a',
  name: 'LA-2A 光学压缩 ⚗',
  color: '#c9862d',
  params: [
    { key: 'reduction', label: 'REDUCTION', min: 0, max: 100, step: 1, defaultValue: 30 },
    { key: 'gain', label: 'GAIN', min: 0, max: 30, step: 0.5, defaultValue: 0, unit: 'dB' },
    { key: 'mode', label: 'MODE', min: 0, max: 1, step: 1, defaultValue: 0 },
  ],
  create(ctx: AudioContext): EffectInstance {
    const input = ctx.createGain();
    const output = ctx.createGain();
    let node: AudioWorkletNode | null = null;
    try {
      node = new AudioWorkletNode(ctx, 'opto-la2a');
      input.connect(node);
      node.connect(output);
    } catch (e) {
      console.warn('LA-2A worklet 未就绪,直通:', e);
      input.connect(output);
    }
    node?.parameters.get('gain')?.setValueAtTime(1, ctx.currentTime);
    return {
      input,
      output,
      update(key, value) {
        const t = ctx.currentTime;
        if (key === 'gain') {
          // dB 域 → 线性增益
          node?.parameters.get('gain')?.setTargetAtTime(dbToGain(value), t, 0.03);
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
