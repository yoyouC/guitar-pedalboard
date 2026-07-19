import type { EffectDefinition } from './types';

const BASE_DELAY = 0.02; // 湿路基准延迟(s)
const MAX_DEPTH = 0.005; // depth 100% 时的 LFO 调制幅度(s)
const SMOOTHING = 0.02; // setTargetAtTime 时间常数(s)

export const chorusEffect: EffectDefinition = {
  id: 'chorus',
  name: 'Chorus',
  color: '#9b59b6',
  params: [
    { key: 'rate', label: 'Rate', min: 0.1, max: 5, step: 0.1, defaultValue: 0.8, unit: 'Hz' },
    { key: 'depth', label: 'Depth', min: 0, max: 100, step: 1, defaultValue: 50, unit: '%' },
    { key: 'mix', label: 'Mix', min: 0, max: 100, step: 1, defaultValue: 50, unit: '%' },
  ],
  create(ctx) {
    const input = ctx.createGain();
    const output = ctx.createGain();

    // 干湿等功率交叉淡化:dry = cos(θ), wet = sin(θ), θ = mix·π/2
    // 任意 mix 下合成电平均不超标(旧实现 dry 恒 1,同相叠加峰值可达 2×)
    const mixAngle = (v: number) => (v / 100) * (Math.PI / 2);
    const dryGain = ctx.createGain();
    dryGain.gain.value = Math.cos(mixAngle(50));
    const wetGain = ctx.createGain();
    wetGain.gain.value = Math.sin(mixAngle(50)); // mix 默认 50%

    // 湿路:基准延迟 20ms,由 LFO 调制 delayTime
    const delay = ctx.createDelay(BASE_DELAY + MAX_DEPTH);
    delay.delayTime.value = BASE_DELAY;

    // LFO:sine → depthGain → delay.delayTime
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.8;
    const depthGain = ctx.createGain();
    depthGain.gain.value = MAX_DEPTH * 0.5; // depth 默认 50%

    input.connect(dryGain);
    dryGain.connect(output);
    input.connect(delay);
    delay.connect(wetGain);
    wetGain.connect(output);
    lfo.connect(depthGain);
    depthGain.connect(delay.delayTime);
    lfo.start();

    return {
      input,
      output,
      update(key, value) {
        const t = ctx.currentTime;
        switch (key) {
          case 'rate':
            lfo.frequency.setTargetAtTime(value, t, SMOOTHING);
            break;
          case 'depth':
            depthGain.gain.setTargetAtTime((value / 100) * MAX_DEPTH, t, SMOOTHING);
            break;
          case 'mix':
            dryGain.gain.setTargetAtTime(Math.cos(mixAngle(value)), t, SMOOTHING);
            wetGain.gain.setTargetAtTime(Math.sin(mixAngle(value)), t, SMOOTHING);
            break;
        }
      },
      dispose() {
        lfo.stop();
        input.disconnect();
        output.disconnect();
        dryGain.disconnect();
        delay.disconnect();
        wetGain.disconnect();
        lfo.disconnect();
        depthGain.disconnect();
      },
    };
  },
};
