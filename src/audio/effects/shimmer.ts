import type { EffectDefinition, EffectInstance } from './types';

/**
 * 微光混响 ⚗:FDN 混响尾经双读头调制延迟 +1 八度变调后注入反馈环,
 * 尾音层层升频形成"星空"氛围垫。worklet 实现,加载失败兜底直通。
 */
export const shimmerEffect: EffectDefinition = {
  id: 'shimmer',
  name: '微光混响 ⚗',
  color: '#7b6cf0',
  params: [
    { key: 'time', label: 'TIME', min: 2, max: 8, step: 0.1, defaultValue: 4.5, unit: 's' },
    { key: 'shimmer', label: 'SHIMMER', min: 0, max: 100, step: 1, defaultValue: 40, unit: '%' },
    { key: 'damp', label: 'DAMP', min: 0, max: 100, step: 1, defaultValue: 40, unit: '%' },
    { key: 'mix', label: 'MIX', min: 0, max: 100, step: 1, defaultValue: 35, unit: '%' },
  ],
  create(ctx: AudioContext): EffectInstance {
    const input = ctx.createGain();
    const output = ctx.createGain();
    let node: AudioWorkletNode | null = null;
    try {
      node = new AudioWorkletNode(ctx, 'wdf-shimmer');
      input.connect(node);
      node.connect(output);
    } catch (e) {
      console.warn('微光混响 worklet 未就绪,直通:', e);
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
