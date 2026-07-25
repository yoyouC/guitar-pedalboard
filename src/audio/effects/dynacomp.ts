import type { EffectDefinition, EffectInstance } from './types';
import { LEVEL_DB_MAX, LEVEL_DB_MIN, levelDbToGain } from '../level';

/**
 * Dyna Comp 压缩 ⚗:MXR Dyna Comp 风格 OTA 压缩(反馈式,~11:1,
 * 固定快启动 + 中速释放,标志性"泵感"起音与延音)。
 * worklet 实现,加载失败兜底直通。
 */
export const dynaCompEffect: EffectDefinition = {
  id: 'dynacomp',
  name: 'Dyna Comp 压缩 ⚗',
  color: '#c0392b',
  params: [
    { key: 'sensitivity', label: 'SENSITIVITY', min: 0, max: 100, step: 1, defaultValue: 50 },
    { key: 'level', label: 'LEVEL', min: LEVEL_DB_MIN, max: LEVEL_DB_MAX, step: 0.5, defaultValue: 0, unit: 'dB' },
  ],
  create(ctx: AudioContext): EffectInstance {
    const input = ctx.createGain();
    const output = ctx.createGain();
    let node: AudioWorkletNode | null = null;
    try {
      node = new AudioWorkletNode(ctx, 'wdf-dynacomp');
      input.connect(node);
      node.connect(output);
    } catch (e) {
      console.warn('Dyna Comp worklet 未就绪,直通:', e);
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
