import type { EffectDefinition, EffectInstance } from './types';

/**
 * 模拟延迟 ⚗:BBD 白盒建模(Boss DM-2 / Memory Man 风格)。
 * 逐级低通的变暗重复、本底噪声、可选慢速调制(重复音 vibrato)。
 * worklet 实现(src/audio/wdf/analogdelayWorklet.ts),加载失败兜底直通。
 */
export const analogDelayEffect: EffectDefinition = {
  id: 'analogdelay',
  name: '模拟延迟 ⚗',
  color: '#b0793a',
  params: [
    { key: 'time', label: 'TIME', min: 20, max: 600, step: 1, defaultValue: 300, unit: 'ms' },
    { key: 'feedback', label: 'FEEDBACK', min: 0, max: 95, step: 1, defaultValue: 40, unit: '%' },
    { key: 'tone', label: 'TONE', min: 0, max: 100, step: 1, defaultValue: 55 },
    { key: 'mod', label: 'MOD', min: 0, max: 100, step: 1, defaultValue: 0, unit: '%' },
    { key: 'mix', label: 'MIX', min: 0, max: 100, step: 1, defaultValue: 35, unit: '%' },
  ],
  create(ctx: AudioContext): EffectInstance {
    const input = ctx.createGain();
    const output = ctx.createGain();
    let node: AudioWorkletNode | null = null;
    try {
      node = new AudioWorkletNode(ctx, 'bbd-analog-delay');
      input.connect(node);
      node.connect(output);
    } catch (e) {
      console.warn('模拟延迟 worklet 未就绪,直通:', e);
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
