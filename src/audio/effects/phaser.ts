import type { EffectDefinition, EffectInstance } from './types';

const SMOOTH = 0.02;

/** 4 级 allpass 的基准频率(Hz) */
const STAGE_FREQS = [400, 800, 1600, 3200];
const STAGE_Q = 0.5;
/** depth 0~100 映射到 LFO 摆幅 0~1500 Hz */
const MAX_DEPTH_HZ = 1500;

export const phaserEffect: EffectDefinition = {
  id: 'phaser',
  name: 'Phaser',
  color: '#1abc9c',
  params: [
    { key: 'rate', label: 'Rate', min: 0.1, max: 5, step: 0.1, defaultValue: 0.5, unit: 'Hz' },
    { key: 'depth', label: 'Depth', min: 0, max: 100, step: 1, defaultValue: 70, unit: '%' },
  ],

  create(ctx: AudioContext): EffectInstance {
    const input = ctx.createGain();
    const output = ctx.createGain();

    // 干湿各半混合
    const dryGain = ctx.createGain();
    const wetGain = ctx.createGain();
    dryGain.gain.value = 0.5;
    wetGain.gain.value = 0.5;

    // 4 个级联 allpass
    const stages: BiquadFilterNode[] = STAGE_FREQS.map((freq) => {
      const ap = ctx.createBiquadFilter();
      ap.type = 'allpass';
      ap.frequency.value = freq;
      ap.Q.value = STAGE_Q;
      return ap;
    });

    // 链路: input -> ap1 -> ap2 -> ap3 -> ap4 -> wetGain -> output
    input.connect(stages[0]);
    for (let i = 0; i < stages.length - 1; i++) {
      stages[i].connect(stages[i + 1]);
    }
    stages[stages.length - 1].connect(wetGain);
    wetGain.connect(output);

    // 干路: input -> dryGain -> output
    input.connect(dryGain);
    dryGain.connect(output);

    // LFO -> depthGain -> 每个 allpass.frequency
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.5;
    const depthGain = ctx.createGain();
    depthGain.gain.value = (70 / 100) * MAX_DEPTH_HZ;
    lfo.connect(depthGain);
    for (const ap of stages) {
      depthGain.connect(ap.frequency);
    }
    lfo.start();

    function update(key: string, value: number): void {
      const t = ctx.currentTime;
      switch (key) {
        case 'rate':
          lfo.frequency.setTargetAtTime(value, t, SMOOTH);
          break;
        case 'depth':
          depthGain.gain.setTargetAtTime((value / 100) * MAX_DEPTH_HZ, t, SMOOTH);
          break;
      }
    }

    function dispose(): void {
      lfo.stop();
      lfo.disconnect();
      depthGain.disconnect();
      for (const ap of stages) {
        ap.disconnect();
      }
      dryGain.disconnect();
      wetGain.disconnect();
      input.disconnect();
      output.disconnect();
    }

    return { input, output, update, dispose };
  },
};
