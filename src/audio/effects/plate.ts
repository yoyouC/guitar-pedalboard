import type { EffectDefinition, EffectInstance } from './types';

/**
 * 板式混响 ⚗:EMT-140 风格 FDN(预延迟 + 4 级输入扩散 + 环内 4 全通双延迟反馈,
 * 环内阻尼低通实现高频随时间衰减)。worklet 实现('plate-reverb'),加载失败兜底直通。
 */
export const plateEffect: EffectDefinition = {
  id: 'plate',
  name: '板式混响 ⚗',
  color: '#9b59b6',
  params: [
    { key: 'time', label: 'TIME', min: 0.5, max: 6, step: 0.05, defaultValue: 2.5, unit: 's' },
    { key: 'damp', label: 'DAMP', min: 0, max: 100, step: 1, defaultValue: 40 },
    { key: 'preDelay', label: 'PREDELAY', min: 0, max: 100, step: 1, defaultValue: 0, unit: 'ms' },
    { key: 'mix', label: 'MIX', min: 0, max: 100, step: 1, defaultValue: 30, unit: '%' },
  ],
  create(ctx: AudioContext): EffectInstance {
    const input = ctx.createGain();
    const output = ctx.createGain();
    let node: AudioWorkletNode | null = null;
    try {
      node = new AudioWorkletNode(ctx, 'plate-reverb');
      input.connect(node);
      node.connect(output);
    } catch (e) {
      console.warn('板式混响 worklet 未就绪,直通:', e);
      input.connect(output);
    }
    return {
      input,
      output,
      update(key, value) {
        node?.parameters.get(key)?.setTargetAtTime(value, ctx.currentTime, 0.03);
      },
      dispose() {
        input.disconnect();
        node?.disconnect();
        output.disconnect();
      },
    };
  },
};
