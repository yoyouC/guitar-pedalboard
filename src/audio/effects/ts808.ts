import type { EffectDefinition, EffectInstance } from './types';

const CURVE_LENGTH = 1024;
const SMOOTH = 0.03;
/** TS 削波级在 720Hz 以下增益回落到 1:低频保持干净,形成标志性中频隆起 */
const MID_HUMP_HP_HZ = 720;
/** 中频隆起的后置强调 */
const HUMP_FREQ_HZ = 730;
const HUMP_GAIN_DB = 3;
/** 反馈 51pF 电容:软化削波边角 */
const CORNER_LP_HZ = 7000;
/** 音色级固定无源低通(1K × 0.22uF = 723.4Hz),削掉刺耳泛音 */
const MAIN_LP_HZ = 723;
/** Tone 主动电路的高架中心(3.2kHz 以上高通区) */
const TONE_SHELF_HZ = 3200;

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
/** Tone 0~100 → 高架增益 dB:低频侧削暗(-12dB),高频侧打开 3.2kHz 以上(+3dB) */
const toneToDb = (v: number) => ((v - 50) / 50) * 15;
const levelToOutputGain = (v: number) => (v / 100) * 1.2;

/**
 * Ibanez TS808 风格过载(按 ElectroSmash 电路分析):
 * 削波级反馈 720Hz 高通(低频少削、频率选择性失真)→
 * 反馈二极管软削波 → 51pF 边角软化 → 中频隆起 →
 * 音色级固定 723Hz 无源低通(1K×0.22uF)→ Tone 高架(3.2kHz 主动电路)→ Level。
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
    const cornerLp = ctx.createBiquadFilter();
    const hump = ctx.createBiquadFilter();
    const mainLp = ctx.createBiquadFilter();
    const tone = ctx.createBiquadFilter();

    // 静态初始值(与 params 默认值一致)
    tightBass.type = 'highpass';
    tightBass.frequency.value = MID_HUMP_HP_HZ;
    tightBass.Q.value = 0.707;
    driveGain.gain.value = driveToGain(45);
    shaper.curve = makeTsCurve(2.2);
    shaper.oversample = '4x';
    cornerLp.type = 'lowpass';
    cornerLp.frequency.value = CORNER_LP_HZ;
    hump.type = 'peaking';
    hump.frequency.value = HUMP_FREQ_HZ;
    hump.Q.value = 1;
    hump.gain.value = HUMP_GAIN_DB;
    mainLp.type = 'lowpass';
    mainLp.frequency.value = MAIN_LP_HZ;
    mainLp.Q.value = 0.7;
    tone.type = 'highshelf';
    tone.frequency.value = TONE_SHELF_HZ;
    tone.gain.value = toneToDb(55);
    output.gain.value = levelToOutputGain(65);

    // input → 720Hz 高通 → drive → 软削波 → 边角软化 → 中频隆起
    //      → 723Hz 无源低通 → Tone 高架 → output
    input.connect(tightBass);
    tightBass.connect(driveGain);
    driveGain.connect(shaper);
    shaper.connect(cornerLp);
    cornerLp.connect(hump);
    hump.connect(mainLp);
    mainLp.connect(tone);
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
            tone.gain.setTargetAtTime(toneToDb(value), t, SMOOTH);
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
        cornerLp.disconnect();
        hump.disconnect();
        mainLp.disconnect();
        tone.disconnect();
        output.disconnect();
      },
    };
  },
};
