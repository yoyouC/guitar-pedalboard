import type { EffectDefinition, EffectInstance } from './types';

const CURVE_LENGTH = 1024;
/** 曲线陡峭度:fuzz 量越大,波形越接近方波 */
const CURVE_K_MIN = 1;
const CURVE_K_MAX = 100;
const SMOOTH = 0.03;

/**
 * Fuzz 曲线:对称硬方波化削波。
 * 用 tanh(k*x)/tanh(k) 归一化,k 很大时逼近方波,产生标志性的“毛刺感”。
 */
function makeFuzzCurve(k: number): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(CURVE_LENGTH);
  const norm = Math.tanh(k);
  for (let i = 0; i < CURVE_LENGTH; i++) {
    const x = (i / (CURVE_LENGTH - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

const fuzzToPreGain = (v: number) => 1 + (v / 100) * 59; // 1 ~ 60
const fuzzToK = (v: number) => CURVE_K_MIN + (v / 100) * (CURVE_K_MAX - CURVE_K_MIN);
const levelToOutputGain = (v: number) => (v / 100) * 2;

/** Fuzz 法兹:方波化硬削波 + 音色的经典单块 */
export const fuzzEffect: EffectDefinition = {
  id: 'fuzz',
  name: 'Fuzz',
  color: '#d35400',
  params: [
    { key: 'fuzz', label: 'Fuzz', min: 0, max: 100, step: 1, defaultValue: 65 },
    { key: 'tone', label: 'Tone', min: 400, max: 6000, step: 50, defaultValue: 2200, unit: 'Hz' },
    { key: 'level', label: 'Level', min: 0, max: 100, step: 1, defaultValue: 55 },
  ],
  create(ctx: AudioContext): EffectInstance {
    const input = ctx.createGain();
    const output = ctx.createGain();
    const preGain = ctx.createGain();
    const shaper = ctx.createWaveShaper();
    const tone = ctx.createBiquadFilter();

    // 静态初始值(与 params 默认值一致)
    preGain.gain.value = fuzzToPreGain(65);
    shaper.curve = makeFuzzCurve(fuzzToK(65));
    shaper.oversample = '4x';
    tone.type = 'lowpass';
    tone.frequency.value = 2200;
    tone.Q.value = 0.7;
    output.gain.value = levelToOutputGain(55);

    // input → preGain → WaveShaper → tone(lowpass) → output
    input.connect(preGain);
    preGain.connect(shaper);
    shaper.connect(tone);
    tone.connect(output);

    return {
      input,
      output,
      update(key, value) {
        const t = ctx.currentTime;
        switch (key) {
          case 'fuzz':
            preGain.gain.setTargetAtTime(fuzzToPreGain(value), t, SMOOTH);
            // 曲线不是 AudioParam,直接整体替换
            shaper.curve = makeFuzzCurve(fuzzToK(value));
            break;
          case 'tone':
            tone.frequency.setTargetAtTime(value, t, SMOOTH);
            break;
          case 'level':
            output.gain.setTargetAtTime(levelToOutputGain(value), t, SMOOTH);
            break;
        }
      },
      dispose() {
        input.disconnect();
        preGain.disconnect();
        shaper.disconnect();
        tone.disconnect();
        output.disconnect();
      },
    };
  },
};
