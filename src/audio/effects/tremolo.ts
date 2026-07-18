import type { EffectDefinition, EffectInstance } from './types';

export const tremoloEffect: EffectDefinition = {
  id: 'tremolo',
  name: 'Tremolo',
  color: '#f1c40f',
  params: [
    {
      key: 'rate',
      label: 'Rate',
      min: 0.5,
      max: 10,
      step: 0.1,
      defaultValue: 5,
      unit: 'Hz',
    },
    {
      key: 'depth',
      label: 'Depth',
      min: 0,
      max: 100,
      step: 1,
      defaultValue: 50,
      unit: '%',
    },
  ],
  create(ctx: AudioContext): EffectInstance {
    const input = ctx.createGain();
    const output = ctx.createGain();
    const modGain = ctx.createGain();
    const lfo = ctx.createOscillator();
    const depthGain = ctx.createGain();

    // 静态初始值:rate = 5 Hz,depth = 50(%)
    const initialDepth = 50 / 200; // depth 0~100 映射到 0~0.5
    lfo.type = 'sine';
    lfo.frequency.value = 5;
    depthGain.gain.value = initialDepth;
    modGain.gain.value = 1 - initialDepth; // 基准增益 = 1 - depth/200

    // 链路:input → modGain → output
    input.connect(modGain);
    modGain.connect(output);
    // 调制链路:LFO(sine) → depthGain → modGain.gain
    lfo.connect(depthGain);
    depthGain.connect(modGain.gain);

    lfo.start();

    const update = (key: string, value: number): void => {
      const t = ctx.currentTime;
      if (key === 'rate') {
        lfo.frequency.setTargetAtTime(value, t, 0.02);
      } else if (key === 'depth') {
        const depth = value / 200;
        // 同时平滑调整 LFO 调制深度与基准增益
        depthGain.gain.setTargetAtTime(depth, t, 0.02);
        modGain.gain.setTargetAtTime(1 - depth, t, 0.02);
      }
    };

    const dispose = (): void => {
      lfo.stop();
      lfo.disconnect();
      depthGain.disconnect();
      modGain.disconnect();
      input.disconnect();
      output.disconnect();
    };

    return { input, output, update, dispose };
  },
};
