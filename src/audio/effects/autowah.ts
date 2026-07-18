import type { EffectDefinition, EffectInstance } from './types';

const CURVE_LENGTH = 1024;
const SMOOTH = 0.02;
/** 包络跟随的低通截止:越小越平滑、响应越慢 */
const ENV_LP_HZ = 8;
/** 灵敏度满档时的频率摆动幅度(Hz) */
const MAX_SWEEP_HZ = 4000;

/** 全波整流曲线 y=|x|,把音频变成单向包络信号 */
function makeRectifierCurve(): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(CURVE_LENGTH);
  for (let i = 0; i < CURVE_LENGTH; i++) {
    const x = (i / (CURVE_LENGTH - 1)) * 2 - 1;
    curve[i] = Math.abs(x);
  }
  return curve;
}

const sensToSweep = (v: number) => (v / 100) * MAX_SWEEP_HZ;

/**
 * Auto-Wah 自动哇音:包络跟随器调制带通滤波器中心频率。
 * 包络路径(控制信号,不进 speakers):
 *   input → 整流 WaveShaper → 低通(8Hz) → sweepGain → bandpass.frequency
 * 发声路径:input → bandpass → wetGain → output;input → dryGain → output
 */
export const autowahEffect: EffectDefinition = {
  id: 'autowah',
  name: 'Auto-Wah',
  color: '#27ae60',
  params: [
    { key: 'sens', label: 'SENS', min: 0, max: 100, step: 1, defaultValue: 60 },
    { key: 'freq', label: 'FREQ', min: 150, max: 1200, step: 10, defaultValue: 400, unit: 'Hz' },
    { key: 'reso', label: 'RESO', min: 1, max: 12, step: 0.5, defaultValue: 6 },
    { key: 'mix', label: 'MIX', min: 0, max: 100, step: 1, defaultValue: 100 },
  ],
  create(ctx: AudioContext): EffectInstance {
    const input = ctx.createGain();
    const output = ctx.createGain();

    // 发声路径
    const bandpass = ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.value = 400;
    bandpass.Q.value = 6;
    const wetGain = ctx.createGain();
    wetGain.gain.value = 1;
    const dryGain = ctx.createGain();
    dryGain.gain.value = 0;

    // 包络路径
    const rectifier = ctx.createWaveShaper();
    rectifier.curve = makeRectifierCurve();
    const envLp = ctx.createBiquadFilter();
    envLp.type = 'lowpass';
    envLp.frequency.value = ENV_LP_HZ;
    const sweepGain = ctx.createGain();
    sweepGain.gain.value = sensToSweep(60);

    input.connect(bandpass);
    bandpass.connect(wetGain);
    wetGain.connect(output);
    input.connect(dryGain);
    dryGain.connect(output);

    input.connect(rectifier);
    rectifier.connect(envLp);
    envLp.connect(sweepGain);
    sweepGain.connect(bandpass.frequency);

    return {
      input,
      output,
      update(key, value) {
        const t = ctx.currentTime;
        switch (key) {
          case 'sens':
            sweepGain.gain.setTargetAtTime(sensToSweep(value), t, SMOOTH);
            break;
          case 'freq':
            bandpass.frequency.setTargetAtTime(value, t, SMOOTH);
            break;
          case 'reso':
            bandpass.Q.setTargetAtTime(value, t, SMOOTH);
            break;
          case 'mix': {
            const mix = value / 100;
            wetGain.gain.setTargetAtTime(mix, t, SMOOTH);
            dryGain.gain.setTargetAtTime(1 - mix, t, SMOOTH);
            break;
          }
        }
      },
      dispose() {
        input.disconnect();
        bandpass.disconnect();
        wetGain.disconnect();
        dryGain.disconnect();
        rectifier.disconnect();
        envLp.disconnect();
        sweepGain.disconnect();
        output.disconnect();
      },
    };
  },
};
