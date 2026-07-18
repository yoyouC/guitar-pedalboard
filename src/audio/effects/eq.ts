import type { EffectDefinition, EffectInstance } from './types';

export const eqEffect: EffectDefinition = {
  id: 'eq',
  name: '3-Band EQ',
  color: '#16a085',
  params: [
    { key: 'low', label: 'Low', min: -15, max: 15, step: 0.5, defaultValue: 0, unit: 'dB' },
    { key: 'mid', label: 'Mid', min: -15, max: 15, step: 0.5, defaultValue: 0, unit: 'dB' },
    { key: 'high', label: 'High', min: -15, max: 15, step: 0.5, defaultValue: 0, unit: 'dB' },
  ],
  create(ctx: AudioContext): EffectInstance {
    const input = ctx.createGain();
    const output = ctx.createGain();

    const lowshelf = ctx.createBiquadFilter();
    lowshelf.type = 'lowshelf';
    lowshelf.frequency.value = 100;

    const peaking = ctx.createBiquadFilter();
    peaking.type = 'peaking';
    peaking.frequency.value = 1000;
    peaking.Q.value = 1;

    const highshelf = ctx.createBiquadFilter();
    highshelf.type = 'highshelf';
    highshelf.frequency.value = 4000;

    input.connect(lowshelf);
    lowshelf.connect(peaking);
    peaking.connect(highshelf);
    highshelf.connect(output);

    const smoothGain = (filter: BiquadFilterNode, value: number): void => {
      filter.gain.setTargetAtTime(value, ctx.currentTime, 0.02);
    };

    return {
      input,
      output,
      update(key: string, value: number): void {
        switch (key) {
          case 'low':
            smoothGain(lowshelf, value);
            break;
          case 'mid':
            smoothGain(peaking, value);
            break;
          case 'high':
            smoothGain(highshelf, value);
            break;
        }
      },
      dispose(): void {
        input.disconnect();
        lowshelf.disconnect();
        peaking.disconnect();
        highshelf.disconnect();
        output.disconnect();
      },
    };
  },
};
