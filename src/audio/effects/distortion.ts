import type { EffectDefinition, EffectInstance } from './types';
import { LEVEL_DB_MAX, LEVEL_DB_MIN, levelDbToGain } from '../level';

/** 硬削波阈值,|x| 超过该值处截平 */
const CLIP_THRESHOLD = 0.4;
const CURVE_LENGTH = 1024;
/** setTargetAtTime 平滑时间常数 */
const SMOOTHING = 0.03;

function makeDistortionCurve(): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(CURVE_LENGTH);
  for (let i = 0; i < CURVE_LENGTH; i += 1) {
    const x = (i * 2) / (CURVE_LENGTH - 1) - 1;
    const clipped = Math.max(-CLIP_THRESHOLD, Math.min(CLIP_THRESHOLD, x));
    // 归一化回满幅,保持削波后输出电平可预期
    curve[i] = clipped / CLIP_THRESHOLD;
  }
  return curve;
}

/** gain 参数 0~100 映射到 preGain 1~100 */
function gainToPreGain(value: number): number {
  return 1 + (value / 100) * 99;
}

export const distortionEffect: EffectDefinition = {
  id: 'distortion',
  name: 'Distortion',
  color: '#c0392b',
  params: [
    { key: 'gain', label: 'Gain', min: 0, max: 100, step: 1, defaultValue: 60 },
    { key: 'tone', label: 'Tone', min: 500, max: 8000, step: 50, defaultValue: 2500, unit: 'Hz' },
    { key: 'level', label: 'Level', min: LEVEL_DB_MIN, max: LEVEL_DB_MAX, step: 0.5, defaultValue: -18, unit: 'dB' },
  ],
  create(ctx: AudioContext): EffectInstance {
    const input = ctx.createGain();
    const output = ctx.createGain();
    const preGain = ctx.createGain();
    const shaper = ctx.createWaveShaper();
    const tone = ctx.createBiquadFilter();

    // 静态初始值
    preGain.gain.value = gainToPreGain(60);
    shaper.curve = makeDistortionCurve();
    shaper.oversample = '4x';
    tone.type = 'lowpass';
    tone.frequency.value = 2500;
    tone.Q.value = 0.7;
    output.gain.value = levelDbToGain(-18);

    // input → preGain → WaveShaper → tone(lowpass) → output
    input.connect(preGain);
    preGain.connect(shaper);
    shaper.connect(tone);
    tone.connect(output);

    return {
      input,
      output,
      update(key: string, value: number): void {
        const t = ctx.currentTime;
        switch (key) {
          case 'gain':
            preGain.gain.setTargetAtTime(gainToPreGain(value), t, SMOOTHING);
            break;
          case 'tone':
            tone.frequency.setTargetAtTime(value, t, SMOOTHING);
            break;
          case 'level':
            output.gain.setTargetAtTime(levelDbToGain(value), t, SMOOTHING);
            break;
        }
      },
      dispose(): void {
        input.disconnect();
        preGain.disconnect();
        shaper.disconnect();
        tone.disconnect();
        output.disconnect();
      },
    };
  },
};
