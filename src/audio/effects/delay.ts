import type { EffectDefinition, EffectInstance } from './types';

/**
 * Delay 延迟/回声
 * 链路:input → dryGain → output
 *       input → DelayNode(maxDelay 2s) → wetGain → output
 *       DelayNode → feedbackGain → DelayNode(反馈环)
 */
export const delayEffect: EffectDefinition = {
  id: 'delay',
  name: 'Delay',
  color: '#3498db',
  params: [
    { key: 'time', label: 'Time', min: 50, max: 2000, step: 1, defaultValue: 400, unit: 'ms' },
    { key: 'feedback', label: 'Feedback', min: 0, max: 90, step: 1, defaultValue: 35, unit: '%' },
    { key: 'mix', label: 'Mix', min: 0, max: 100, step: 1, defaultValue: 30, unit: '%' },
  ],

  create(ctx: AudioContext): EffectInstance {
    const input = ctx.createGain();
    const output = ctx.createGain();

    const dryGain = ctx.createGain();
    dryGain.gain.value = 1; // 干路恒为 1

    const delayNode = ctx.createDelay(2);
    delayNode.delayTime.value = 0.4; // 400ms

    const wetGain = ctx.createGain();
    wetGain.gain.value = 0.3; // mix 30%

    const feedbackGain = ctx.createGain();
    feedbackGain.gain.value = 0.35; // feedback 35%

    // 干路
    input.connect(dryGain);
    dryGain.connect(output);
    // 湿路
    input.connect(delayNode);
    delayNode.connect(wetGain);
    wetGain.connect(output);
    // 反馈环
    delayNode.connect(feedbackGain);
    feedbackGain.connect(delayNode);

    const update = (key: string, value: number): void => {
      const now = ctx.currentTime;
      switch (key) {
        case 'time':
          // ms → s
          delayNode.delayTime.setTargetAtTime(value / 1000, now, 0.02);
          break;
        case 'feedback':
          // 0~90 → 0~0.9
          feedbackGain.gain.setTargetAtTime(value / 100, now, 0.02);
          break;
        case 'mix':
          // 0~100 → 湿路 0~1
          wetGain.gain.setTargetAtTime(value / 100, now, 0.02);
          break;
      }
    };

    const dispose = (): void => {
      input.disconnect();
      output.disconnect();
      dryGain.disconnect();
      delayNode.disconnect();
      wetGain.disconnect();
      feedbackGain.disconnect();
    };

    return { input, output, update, dispose };
  },
};
