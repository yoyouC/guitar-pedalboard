import type { EffectDefinition, EffectInstance } from './types';

/** dB 转线性增益 */
function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

const SMOOTH = 0.02;

export const compressorEffect: EffectDefinition = {
  id: 'compressor',
  name: 'Compressor',
  color: '#4a90d9',
  params: [
    { key: 'threshold', label: 'Threshold', min: -60, max: 0, step: 1, defaultValue: -24, unit: 'dB' },
    { key: 'ratio', label: 'Ratio', min: 1, max: 20, step: 0.5, defaultValue: 4 },
    { key: 'attack', label: 'Attack', min: 0, max: 100, step: 1, defaultValue: 10, unit: 'ms' },
    { key: 'release', label: 'Release', min: 10, max: 1000, step: 10, defaultValue: 250, unit: 'ms' },
    { key: 'makeup', label: 'Makeup', min: 0, max: 24, step: 0.5, defaultValue: 0, unit: 'dB' },
  ],

  create(ctx: AudioContext): EffectInstance {
    const input = ctx.createGain();
    const output = ctx.createGain();

    const comp = ctx.createDynamicsCompressor();
    const makeup = ctx.createGain();

    // 链路: input -> comp -> makeup -> output
    input.connect(comp);
    comp.connect(makeup);
    makeup.connect(output);

    // 静态初始值(与 params 默认值一致)
    comp.threshold.value = -24;
    comp.ratio.value = 4;
    comp.attack.value = 10 / 1000;
    comp.release.value = 250 / 1000;
    comp.knee.value = 12;
    makeup.gain.value = dbToLinear(0);

    function update(key: string, value: number): void {
      const t = ctx.currentTime;
      switch (key) {
        case 'threshold':
          comp.threshold.setTargetAtTime(value, t, SMOOTH);
          break;
        case 'ratio':
          comp.ratio.setTargetAtTime(value, t, SMOOTH);
          break;
        case 'attack':
          comp.attack.setTargetAtTime(value / 1000, t, SMOOTH);
          break;
        case 'release':
          comp.release.setTargetAtTime(value / 1000, t, SMOOTH);
          break;
        case 'makeup':
          makeup.gain.setTargetAtTime(dbToLinear(value), t, SMOOTH);
          break;
      }
    }

    function dispose(): void {
      input.disconnect();
      comp.disconnect();
      makeup.disconnect();
      output.disconnect();
    }

    return { input, output, update, dispose };
  },
};
