import type { EffectDefinition, EffectInstance } from './types';

const CURVE_LENGTH = 1024;
const SMOOTH = 0.03;
/** 削波前高通:RAT 削波级反馈网络在 1.5kHz 以下衰减 20dB/dec,
 * 低频少削、频率选择性失真——RAT 紧实低频的来源 */
const PRE_CLIP_HP_HZ = 1500;
/** 反馈 100pF 电容的边角软化(削波前) */
const FEEDBACK_LP_HZ = 16000;
/** 模拟 LM308 慢摆率(0.3V/us):9V 峰值下 5.3kHz 以上跟不上 */
const SLEW_TAME_HZ = 5300;
/** Filter 旋钮行程(实测电路):逆时针全开(32kHz)→ 顺时针压到 475Hz */
const FILTER_MAX_HZ = 32000;
const FILTER_MIN_HZ = 475;
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
const levelToOutputGain = (v: number) => (v / 100) * 1.2;

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
    const preClipHp = ctx.createBiquadFilter();
    const driveGain = ctx.createGain();
    const feedbackLp = ctx.createBiquadFilter();
    const shaper = ctx.createWaveShaper();
    const slewTame = ctx.createBiquadFilter();
    const filter = ctx.createBiquadFilter();

    // 静态初始值(与 params 默认值一致)
    preClipHp.type = 'highpass';
    preClipHp.frequency.value = PRE_CLIP_HP_HZ;
    preClipHp.Q.value = 0.5;
    driveGain.gain.value = driveToGain(55);
    feedbackLp.type = 'lowpass';
    feedbackLp.frequency.value = FEEDBACK_LP_HZ;
    shaper.curve = makeRatCurve();
    shaper.oversample = '4x';
    slewTame.type = 'lowpass';
    slewTame.frequency.value = SLEW_TAME_HZ;
    filter.type = 'lowpass';
    filter.Q.value = 0.7;
    filter.frequency.value = filterToFreq(35);
    output.gain.value = levelToOutputGain(60);

    // input → 削波前高通(1.5k) → drive → 反馈边角软化 → 硬削波
    //      → LM308 摆率软化 → Filter(反向) → output
    input.connect(preClipHp);
    preClipHp.connect(driveGain);
    driveGain.connect(feedbackLp);
    feedbackLp.connect(shaper);
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
        preClipHp.disconnect();
        driveGain.disconnect();
        feedbackLp.disconnect();
        shaper.disconnect();
        slewTame.disconnect();
        filter.disconnect();
        output.disconnect();
      },
    };
  },
};
