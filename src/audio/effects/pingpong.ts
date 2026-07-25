import type { EffectDefinition, EffectInstance } from './types';

/**
 * 乒乓延迟 ⚗:立体声交叉耦合双延迟线,回声在 L/R 声道严格交替反弹,
 * 反馈路径带轻度低通(3.5kHz),重复渐暗。
 * worklet 实现(需 AudioEngine 启动时经 loadPingPongDelay 预加载),加载失败兜底直通。
 * 输出强制立体声(outputChannelCount:[2]),单声道输入首回声在 L 侧。
 */
export const pingpongEffect: EffectDefinition = {
  id: 'pingpong',
  name: '乒乓延迟 ⚗',
  color: '#9b59b6',
  params: [
    { key: 'time', label: 'TIME', min: 50, max: 1500, step: 1, defaultValue: 400, unit: 'ms' },
    { key: 'feedback', label: 'FEEDBACK', min: 0, max: 90, step: 1, defaultValue: 40, unit: '%' },
    { key: 'mix', label: 'MIX', min: 0, max: 100, step: 1, defaultValue: 30, unit: '%' },
  ],
  create(ctx: AudioContext): EffectInstance {
    const input = ctx.createGain();
    const output = ctx.createGain();
    let node: AudioWorkletNode | null = null;
    try {
      node = new AudioWorkletNode(ctx, 'pingpong-delay', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      input.connect(node);
      node.connect(output);
    } catch (e) {
      console.warn('乒乓延迟 worklet 未就绪,直通:', e);
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
