import { makeImpulseResponse } from '../impulseResponse';
import type { EffectDefinition, EffectInstance } from './types';

export const reverbEffect: EffectDefinition = {
  id: 'reverb',
  name: 'Reverb',
  color: '#5d6d7e',
  params: [
    { key: 'time', label: 'Time', min: 0.5, max: 6, step: 0.1, defaultValue: 2.5, unit: 's' },
    { key: 'decay', label: 'Decay', min: 1, max: 6, step: 0.1, defaultValue: 2.5 },
    { key: 'mix', label: 'Mix', min: 0, max: 100, step: 1, defaultValue: 35, unit: '%' },
  ],
  create(ctx: AudioContext): EffectInstance {
    const input = ctx.createGain();
    const output = ctx.createGain();
    const dryGain = ctx.createGain();
    const wetGain = ctx.createGain();
    const convolver = ctx.createConvolver();

    let time = 2.5;
    let decay = 2.5;

    const rebuildIR = (): void => {
      convolver.buffer = makeImpulseResponse(ctx, time, decay);
    };
    rebuildIR();

    // 干路恒为 1,湿路由 mix(0~100)映射到 0~1
    dryGain.gain.value = 1;
    wetGain.gain.value = 35 / 100;

    input.connect(dryGain);
    dryGain.connect(output);
    input.connect(convolver);
    convolver.connect(wetGain);
    wetGain.connect(output);

    return {
      input,
      output,
      update(key: string, value: number): void {
        switch (key) {
          case 'time':
            time = value;
            rebuildIR();
            break;
          case 'decay':
            decay = value;
            rebuildIR();
            break;
          case 'mix':
            wetGain.gain.setTargetAtTime(value / 100, ctx.currentTime, 0.02);
            break;
        }
      },
      dispose(): void {
        input.disconnect();
        output.disconnect();
        dryGain.disconnect();
        wetGain.disconnect();
        convolver.disconnect();
      },
    };
  },
};
