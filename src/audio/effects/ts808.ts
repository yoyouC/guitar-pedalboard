import type { EffectDefinition, EffectInstance } from './types';

const CURVE_LENGTH = 1024;
const SMOOTH = 0.03;
/** TS 削波级在 720Hz 以下增益回落到 1:低频保持干净,形成标志性中频隆起 */
const MID_HUMP_HP_HZ = 720;
/** 中频隆起的后置强调 */
const HUMP_FREQ_HZ = 730;
const HUMP_GAIN_DB = 4.5;
/** Tone 旋钮行程(顺时针更亮) */
const TONE_MIN_HZ = 1200;
const TONE_MAX_HZ = 8000;

/**
 * TS 软削波曲线:二极管在运放反馈回路中, knee 圆润、对称。
 * y = tanh(k·x)/tanh(k),k 较小保持“软”。
 */
function makeTsCurve(k: number): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(CURVE_LENGTH);
  const norm = Math.tanh(k);
  for (let i = 0; i < CURVE_LENGTH; i++) {
    const x = (i / (CURVE_LENGTH - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

const driveToGain = (v: number) => 1 + (v / 100) * 39; // 1 ~ 40
const toneToFreq = (v: number) =>
  TONE_MIN_HZ * Math.pow(TONE_MAX_HZ / TONE_MIN_HZ, v / 100);
const levelToOutputGain = (v: number) => (v / 100) * 2;

/**
 * Ibanez TS808 风格过载:720Hz 高通(低频不削、中频隆起)→
 * 反馈二极管软削波 → 中频强调 → Tone 低通 → Level。
 */
export const ts808Effect: EffectDefinition = {
  id: 'ts808',
  name: 'TS808 Drive',
  color: '#2e8b57',
  params: [
    { key: 'drive', label: 'DRIVE', min: 0, max: 100, step: 1, defaultValue: 45 },
    { key: 'tone', label: 'TONE', min: 0, max: 100, step: 1, defaultValue: 55 },
    { key: 'level', label: 'LEVEL', min: 0, max: 100, step: 1, defaultValue: 65 },
  ],
  create(ctx: AudioContext): EffectInstance {
    const input = ctx.createGain();
    const output = ctx.createGain();
    const tightBass = ctx.createBiquadFilter();
    const driveGain = ctx.createGain();
    const shaper = ctx.createWaveShaper();
    const hump = ctx.createBiquadFilter();
    const tone = ctx.createBiquadFilter();

    // 静态初始值(与 params 默认值一致)
    tightBass.type = 'highpass';
    tightBass.frequency.value = MID_HUMP_HP_HZ;
    tightBass.Q.value = 0.707;
    driveGain.gain.value = driveToGain(45);
    shaper.curve = makeTsCurve(2.2);
    shaper.oversample = '4x';
    hump.type = 'peaking';
    hump.frequency.value = HUMP_FREQ_HZ;
    hump.Q.value = 1.2;
    hump.gain.value = HUMP_GAIN_DB;
    tone.type = 'lowpass';
    tone.Q.value = 0.7;
    tone.frequency.value = toneToFreq(55);
    output.gain.value = levelToOutputGain(65);

    // input → 720Hz 高通 → drive → 软削波 → 中频隆起 → Tone → output
    input.connect(tightBass);
    tightBass.connect(driveGain);
    driveGain.connect(shaper);
    shaper.connect(hump);
    hump.connect(tone);
    tone.connect(output);

    return {
      input,
      output,
      update(key, value) {
        const t = ctx.currentTime;
        switch (key) {
          case 'drive':
            driveGain.gain.setTargetAtTime(driveToGain(value), t, SMOOTH);
            break;
          case 'tone':
            tone.frequency.setTargetAtTime(toneToFreq(value), t, SMOOTH);
            break;
          case 'level':
            output.gain.setTargetAtTime(levelToOutputGain(value), t, SMOOTH);
            break;
        }
      },
      dispose() {
        input.disconnect();
        tightBass.disconnect();
        driveGain.disconnect();
        shaper.disconnect();
        hump.disconnect();
        tone.disconnect();
        output.disconnect();
      },
    };
  },
};
