import type { EffectDefinition, EffectInstance } from './types';
import { LEVEL_DB_MAX, LEVEL_DB_MIN, levelDbToGain } from '../level';

const CURVE_LENGTH = 1024;
const SMOOTH = 0.03;
/** 透明感的核心:干声始终并联混入(模拟 Klon 的 clean blend) */
const DRY_BLEND = 0.4;
/** Treble 搁架中心频率与范围 */
const TREBLE_HZ = 3000;
const TREBLE_RANGE_DB = 10;

/**
 * 锗管削波曲线:阈值低、knee 略圆的软削波(锗二极管 Vf≈0.3V 的听感)。
 */
function makeGermaniumCurve(k: number): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(CURVE_LENGTH);
  const norm = Math.tanh(k);
  for (let i = 0; i < CURVE_LENGTH; i++) {
    const x = (i / (CURVE_LENGTH - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

const gainToPreGain = (v: number) => 1 + (v / 100) * 49; // 1 ~ 50
const trebleToDb = (v: number) => ((v - 50) / 50) * TREBLE_RANGE_DB; // -10 ~ +10 dB

/**
 * Klon 风格透明过载:干声并联混合(clean blend)+ 锗管软削波 +
 * Treble 高频搁架。低增益时几乎是纯净激励,推大后颗粒感渐显。
 */
export const klonEffect: EffectDefinition = {
  id: 'klon',
  name: 'Transparent OD',
  color: '#c8a24a',
  params: [
    { key: 'gain', label: 'GAIN', min: 0, max: 100, step: 1, defaultValue: 35 },
    { key: 'treble', label: 'TREBLE', min: 0, max: 100, step: 1, defaultValue: 50 },
    { key: 'level', label: 'LEVEL', min: LEVEL_DB_MIN, max: LEVEL_DB_MAX, step: 0.5, defaultValue: -19.5, unit: 'dB' },
  ],
  create(ctx: AudioContext): EffectInstance {
    const input = ctx.createGain();
    const output = ctx.createGain();

    // 削波路径
    const preGain = ctx.createGain();
    const shaper = ctx.createWaveShaper();
    const treble = ctx.createBiquadFilter();
    const wetGain = ctx.createGain();
    // 干声并联路径(clean blend)
    const dryGain = ctx.createGain();

    // 静态初始值(与 params 默认值一致)
    preGain.gain.value = gainToPreGain(35);
    shaper.curve = makeGermaniumCurve(3.5);
    shaper.oversample = '4x';
    treble.type = 'highshelf';
    treble.frequency.value = TREBLE_HZ;
    treble.gain.value = trebleToDb(50);
    wetGain.gain.value = 1;
    dryGain.gain.value = DRY_BLEND;
    output.gain.value = levelDbToGain(-19.5);

    // 削波路径:input → preGain → 锗管削波 → treble → wetGain → output
    input.connect(preGain);
    preGain.connect(shaper);
    shaper.connect(treble);
    treble.connect(wetGain);
    wetGain.connect(output);
    // 干声路径:input → dryGain → output
    input.connect(dryGain);
    dryGain.connect(output);

    return {
      input,
      output,
      update(key, value) {
        const t = ctx.currentTime;
        switch (key) {
          case 'gain':
            preGain.gain.setTargetAtTime(gainToPreGain(value), t, SMOOTH);
            break;
          case 'treble':
            treble.gain.setTargetAtTime(trebleToDb(value), t, SMOOTH);
            break;
          case 'level':
            output.gain.setTargetAtTime(levelDbToGain(value), t, SMOOTH);
            break;
        }
      },
      dispose() {
        input.disconnect();
        preGain.disconnect();
        shaper.disconnect();
        treble.disconnect();
        wetGain.disconnect();
        dryGain.disconnect();
        output.disconnect();
      },
    };
  },
};
