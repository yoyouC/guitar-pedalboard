import type { EffectDefinition, EffectInstance } from './types';

const CURVE_LENGTH = 1024;
const SMOOTH = 0.03;
/** 模拟 LM308 慢摆率对超高频的天然软化 */
const SLEW_TAME_HZ = 9000;
/** Filter 旋钮行程:逆时针全开(12kHz)→ 顺时针压到 450Hz(反向音色旋钮) */
const FILTER_MAX_HZ = 12000;
const FILTER_MIN_HZ = 450;
/** 硬削波阈值(归一化) */
const CLIP_T = 0.45;

/**
 * RAT 硬削波曲线:硅二极管直接对地短路,阈值处急转弯、对称截平。
 */
function makeRatCurve(): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(CURVE_LENGTH);
  for (let i = 0; i < CURVE_LENGTH; i++) {
    const x = (i / (CURVE_LENGTH - 1)) * 2 - 1;
    curve[i] = Math.max(-CLIP_T, Math.min(CLIP_T, x)) / CLIP_T;
  }
  return curve;
}

const driveToGain = (v: number) => 1 + (v / 100) * 99; // 1 ~ 100
/** Filter 值 0~100 → 截止频率,指数映射,值越大频率越低(反向) */
const filterToFreq = (v: number) =>
  FILTER_MAX_HZ * Math.pow(FILTER_MIN_HZ / FILTER_MAX_HZ, v / 100);
const levelToOutputGain = (v: number) => (v / 100) * 2;

/**
 * Pro Co RAT 风格失真:高增益运放 → 硅二极管对地硬削波 →
 * 固定高频软化(LM308 摆率) → 反向 Filter 单极点低通 → 音量。
 */
export const ratEffect: EffectDefinition = {
  id: 'rat',
  name: 'RAT Dist',
  color: '#26262a',
  params: [
    { key: 'drive', label: 'DIST', min: 0, max: 100, step: 1, defaultValue: 55 },
    { key: 'filter', label: 'FILTER', min: 0, max: 100, step: 1, defaultValue: 35 },
    { key: 'level', label: 'LEVEL', min: 0, max: 100, step: 1, defaultValue: 60 },
  ],
  create(ctx: AudioContext): EffectInstance {
    const input = ctx.createGain();
    const output = ctx.createGain();
    const driveGain = ctx.createGain();
    const shaper = ctx.createWaveShaper();
    const slewTame = ctx.createBiquadFilter();
    const filter = ctx.createBiquadFilter();

    // 静态初始值(与 params 默认值一致)
    driveGain.gain.value = driveToGain(55);
    shaper.curve = makeRatCurve();
    shaper.oversample = '4x';
    slewTame.type = 'lowpass';
    slewTame.frequency.value = SLEW_TAME_HZ;
    filter.type = 'lowpass';
    filter.Q.value = 0.7;
    filter.frequency.value = filterToFreq(35);
    output.gain.value = levelToOutputGain(60);

    // input → drive → 硬削波 → 摆率软化 → Filter(反向) → output
    input.connect(driveGain);
    driveGain.connect(shaper);
    shaper.connect(slewTame);
    slewTame.connect(filter);
    filter.connect(output);

    return {
      input,
      output,
      update(key, value) {
        const t = ctx.currentTime;
        switch (key) {
          case 'drive':
            driveGain.gain.setTargetAtTime(driveToGain(value), t, SMOOTH);
            break;
          case 'filter':
            filter.frequency.setTargetAtTime(filterToFreq(value), t, SMOOTH);
            break;
          case 'level':
            output.gain.setTargetAtTime(levelToOutputGain(value), t, SMOOTH);
            break;
        }
      },
      dispose() {
        input.disconnect();
        driveGain.disconnect();
        shaper.disconnect();
        slewTame.disconnect();
        filter.disconnect();
        output.disconnect();
      },
    };
  },
};
