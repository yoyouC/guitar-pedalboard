import type { EffectDefinition, EffectInstance } from './types';

/** level 0~100 → output.gain 0~1.2 */
const LEVEL_TO_GAIN = 1.2 / 100;
/** pan -50~+50 → panner.pan -1~+1 */
const PAN_TO_PAN = 1 / 50;

export const volumeEffect: EffectDefinition = {
  id: 'volume',
  name: 'Volume & Pan',
  color: '#bdc3c7',
  params: [
    {
      key: 'level',
      label: 'Level',
      min: 0,
      max: 100,
      step: 1,
      defaultValue: 80,
      unit: '%',
    },
    {
      key: 'pan',
      label: 'Pan',
      min: -50,
      max: 50,
      step: 1,
      defaultValue: 0,
    },
  ],
  create(ctx: AudioContext): EffectInstance {
    const input = ctx.createGain();
    const output = ctx.createGain();
    const panner = ctx.createStereoPanner();

    // 静态初始值
    output.gain.value = 80 * LEVEL_TO_GAIN;
    panner.pan.value = 0;

    input.connect(panner);
    panner.connect(output);

    return {
      input,
      output,
      update(key: string, value: number): void {
        const now = ctx.currentTime;
        switch (key) {
          case 'level':
            output.gain.setTargetAtTime(value * LEVEL_TO_GAIN, now, 0.03);
            break;
          case 'pan':
            panner.pan.setTargetAtTime(value * PAN_TO_PAN, now, 0.03);
            break;
        }
      },
      dispose(): void {
        input.disconnect();
        panner.disconnect();
        output.disconnect();
      },
    };
  },
};
