import type { EffectDefinition, EffectInstance } from './types';

const BASE_DELAY = 0.003;
const MAX_DEPTH_DELAY = 0.002;
const SMOOTH_TIME = 0.03;

/**
 * Flanger 镶边:短延迟 + 反馈环。
 * input → delay → wetGain → output;delay → feedbackGain → delay(反馈);
 * LFO → depthGain → delay.delayTime;input → dryGain → output。
 */
export const flangerEffect: EffectDefinition = {
  id: 'flanger',
  name: 'Flanger',
  color: '#e67e22',
  params: [
    { key: 'rate', label: 'Rate', min: 0.1, max: 2, step: 0.01, defaultValue: 0.3, unit: 'Hz' },
    { key: 'depth', label: 'Depth', min: 0, max: 100, step: 1, defaultValue: 60, unit: '%' },
    { key: 'feedback', label: 'Feedback', min: 0, max: 95, step: 1, defaultValue: 50, unit: '%' },
    { key: 'mix', label: 'Mix', min: 0, max: 100, step: 1, defaultValue: 50, unit: '%' },
  ],
  create(ctx: AudioContext): EffectInstance {
    const input = ctx.createGain();
    const output = ctx.createGain();
    const dryGain = ctx.createGain();
    const wetGain = ctx.createGain();
    const delay = ctx.createDelay(0.02);
    const feedbackGain = ctx.createGain();
    const depthGain = ctx.createGain();
    const lfo = ctx.createOscillator();

    // 静态初始值(默认参数)
    lfo.frequency.value = 0.3;
    delay.delayTime.value = BASE_DELAY;
    depthGain.gain.value = (60 / 100) * MAX_DEPTH_DELAY;
    feedbackGain.gain.value = 0.5;
    dryGain.gain.value = 0.5;
    wetGain.gain.value = 0.5;

    input.connect(dryGain);
    dryGain.connect(output);
    input.connect(delay);
    delay.connect(wetGain);
    wetGain.connect(output);
    delay.connect(feedbackGain);
    feedbackGain.connect(delay);
    lfo.connect(depthGain);
    depthGain.connect(delay.delayTime);

    lfo.start();

    const applyMix = (mix: number): void => {
      const t = ctx.currentTime;
      dryGain.gain.setTargetAtTime(1 - mix, t, SMOOTH_TIME);
      wetGain.gain.setTargetAtTime(mix, t, SMOOTH_TIME);
    };

    const update = (key: string, value: number): void => {
      const t = ctx.currentTime;
      switch (key) {
        case 'rate':
          lfo.frequency.setTargetAtTime(value, t, SMOOTH_TIME);
          break;
        case 'depth':
          depthGain.gain.setTargetAtTime((value / 100) * MAX_DEPTH_DELAY, t, SMOOTH_TIME);
          break;
        case 'feedback':
          feedbackGain.gain.setTargetAtTime(value / 100, t, SMOOTH_TIME);
          break;
        case 'mix':
          applyMix(value / 100);
          break;
      }
    };

    const dispose = (): void => {
      lfo.stop();
      lfo.disconnect();
      depthGain.disconnect();
      feedbackGain.disconnect();
      delay.disconnect();
      wetGain.disconnect();
      dryGain.disconnect();
      input.disconnect();
      output.disconnect();
    };

    return { input, output, update, dispose };
  },
};
