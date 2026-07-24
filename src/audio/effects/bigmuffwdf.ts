import type { EffectDefinition, EffectInstance } from './types';
import { LEVEL_DB_MAX, LEVEL_DB_MIN, levelDbToGain } from '../level';

/**
 * Big Muff WDF ⚗:EHX Big Muff Pi(V3)的 WDF 精确电路建模版。
 * 两级 BJT 增益 + 1N4148 对地削波 + 标志性 LP/HP 交叉淡化 TONE。
 * worklet 实现,加载失败兜底直通。
 */
export const bigmuffWdfEffect: EffectDefinition = {
  id: 'bigmuffwdf',
  name: 'Big Muff WDF ⚗',
  color: '#b03a2e',
  params: [
    { key: 'sustain', label: 'SUSTAIN', min: 0, max: 100, step: 1, defaultValue: 50 },
    { key: 'tone', label: 'TONE', min: 0, max: 100, step: 1, defaultValue: 50 },
    { key: 'level', label: 'LEVEL', min: LEVEL_DB_MIN, max: LEVEL_DB_MAX, step: 0.5, defaultValue: 0, unit: 'dB' },
  ],
  create(ctx: AudioContext): EffectInstance {
    const input = ctx.createGain();
    const output = ctx.createGain();
    let node: AudioWorkletNode | null = null;
    try {
      node = new AudioWorkletNode(ctx, 'wdf-bigmuff');
      input.connect(node);
      node.connect(output);
    } catch (e) {
      console.warn('Big Muff WDF worklet 未就绪,直通:', e);
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
