import type { EffectDefinition, EffectInstance } from './types';

/** drive 参数(0~100)映射 preGain 增益范围 1~50 */
const PRE_GAIN_MIN = 1;
const PRE_GAIN_MAX = 50;

/** tanh 软削波曲线 k 系数范围,随 drive 增大(0~100 → 1~50) */
const CURVE_K_MIN = 1;
const CURVE_K_MAX = 50;

/** level 参数(0~100)映射输出增益 0~2 */
const LEVEL_GAIN_MAX = 1.2;

/** WaveShaper 曲线采样点数 */
const CURVE_POINTS = 1024;

/** 参数平滑时间常数(s),契约要求 0.01~0.05 */
const SMOOTHING_TIME = 0.03;

/** 参数默认值(与下方 params 声明保持一致) */
const DEFAULT_DRIVE = 50;
const DEFAULT_TONE = 3000;
const DEFAULT_LEVEL = 70;

function mapLinear(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number {
  return outMin + ((value - inMin) / (inMax - inMin)) * (outMax - outMin);
}

/** 生成 1024 点 tanh 软削波曲线:y = tanh(k * x),x ∈ [-1, 1] */
function makeTanhCurve(k: number): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(CURVE_POINTS);
  for (let i = 0; i < CURVE_POINTS; i++) {
    const x = (i / (CURVE_POINTS - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x);
  }
  return curve;
}

export const overdriveEffect: EffectDefinition = {
  id: 'overdrive',
  name: 'Overdrive',
  color: '#3f9e4d',
  params: [
    { key: 'drive', label: 'Drive', min: 0, max: 100, step: 1, defaultValue: DEFAULT_DRIVE, unit: '%' },
    { key: 'tone', label: 'Tone', min: 500, max: 8000, step: 50, defaultValue: DEFAULT_TONE, unit: 'Hz' },
    { key: 'level', label: 'Level', min: 0, max: 100, step: 1, defaultValue: DEFAULT_LEVEL, unit: '%' },
  ],

  create(ctx: AudioContext): EffectInstance {
    // 链路:input → preGain → WaveShaper(tanh 软削波) → tone(lowpass) → output
    const input = ctx.createGain();
    const preGain = ctx.createGain();
    const shaper = ctx.createWaveShaper();
    const tone = ctx.createBiquadFilter();
    const output = ctx.createGain();

    // 静态初始值(仅创建阶段直接赋值)
    preGain.gain.value = mapLinear(DEFAULT_DRIVE, 0, 100, PRE_GAIN_MIN, PRE_GAIN_MAX);
    shaper.curve = makeTanhCurve(mapLinear(DEFAULT_DRIVE, 0, 100, CURVE_K_MIN, CURVE_K_MAX));
    shaper.oversample = '4x';
    tone.type = 'lowpass';
    tone.frequency.value = DEFAULT_TONE;
    tone.Q.value = 0.707;
    output.gain.value = mapLinear(DEFAULT_LEVEL, 0, 100, 0, LEVEL_GAIN_MAX);

    input.connect(preGain);
    preGain.connect(shaper);
    shaper.connect(tone);
    tone.connect(output);

    const update = (key: string, value: number): void => {
      const now = ctx.currentTime;
      switch (key) {
        case 'drive':
          // preGain 用 setTargetAtTime 平滑;曲线非 AudioParam,重新生成后整体替换
          preGain.gain.setTargetAtTime(
            mapLinear(value, 0, 100, PRE_GAIN_MIN, PRE_GAIN_MAX),
            now,
            SMOOTHING_TIME,
          );
          shaper.curve = makeTanhCurve(mapLinear(value, 0, 100, CURVE_K_MIN, CURVE_K_MAX));
          break;
        case 'tone':
          tone.frequency.setTargetAtTime(value, now, SMOOTHING_TIME);
          break;
        case 'level':
          output.gain.setTargetAtTime(
            mapLinear(value, 0, 100, 0, LEVEL_GAIN_MAX),
            now,
            SMOOTHING_TIME,
          );
          break;
      }
    };

    const dispose = (): void => {
      // 本效果无内部 LFO/定时器,断开所有内部节点
      input.disconnect();
      preGain.disconnect();
      shaper.disconnect();
      tone.disconnect();
      output.disconnect();
    };

    return { input, output, update, dispose };
  },
};
