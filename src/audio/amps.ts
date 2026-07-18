import type { EffectDefinition, EffectInstance } from './effects/types';

const CURVE_LENGTH = 1024;
const SMOOTH = 0.03;

/** tanh 软削波曲线,k 越大越硬 */
function makeClipCurve(k: number): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(CURVE_LENGTH);
  const norm = Math.tanh(k);
  for (let i = 0; i < CURVE_LENGTH; i++) {
    const x = (i / (CURVE_LENGTH - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

/** 每款箱头的声音特征配置 */
interface AmpModelConfig {
  /** 前置增益最大倍数(激励削波级) */
  preGainMax: number;
  /** 前级削波硬度 */
  preClipK: number;
  /** 削波前高通:高增益箱头切低频保持紧实 */
  preHpHz: number;
  /** 音色特征峰(voicing):频率/dB 增益 */
  voicingFreq: number;
  voicingGainDb: number;
  /** 后级(电源管)饱和硬度 */
  powerClipK: number;
  /** 箱体模拟:低通截止与共振峰 */
  cabLpHz: number;
  cabPeakFreq: number;
  cabPeakGainDb: number;
  defaults: { gain: number; bass: number; mid: number; treble: number; presence: number; master: number };
}

const AMP_MODELS: Record<string, AmpModelConfig> = {
  clean: {
    // Fender Twin Reverb 类:低增益、清亮、中频略凹
    preGainMax: 8,
    preClipK: 1.2,
    preHpHz: 60,
    voicingFreq: 600,
    voicingGainDb: -2,
    powerClipK: 1.2,
    cabLpHz: 6000,
    cabPeakFreq: 3200,
    cabPeakGainDb: 2,
    defaults: { gain: 40, bass: 55, mid: 45, treble: 65, presence: 50, master: 70 },
  },
  crunch: {
    // Marshall Plexi/JCM800 类:中频突出、经典碎音
    preGainMax: 40,
    preClipK: 3,
    preHpHz: 90,
    voicingFreq: 800,
    voicingGainDb: 3,
    powerClipK: 2,
    cabLpHz: 4800,
    cabPeakFreq: 2800,
    cabPeakGainDb: 2.5,
    defaults: { gain: 60, bass: 50, mid: 65, treble: 60, presence: 55, master: 70 },
  },
  recto: {
    // Mesa Dual Rectifier 类:高增益、低频紧实、现代金属
    preGainMax: 70,
    preClipK: 6,
    preHpHz: 120,
    voicingFreq: 500,
    voicingGainDb: -3,
    powerClipK: 2.5,
    cabLpHz: 4500,
    cabPeakFreq: 3000,
    cabPeakGainDb: 3,
    defaults: { gain: 70, bass: 60, mid: 40, treble: 60, presence: 60, master: 70 },
  },
  chime: {
    // Vox AC30 类:中高频“钟声”感、柔顺过载
    preGainMax: 25,
    preClipK: 2.2,
    preHpHz: 80,
    voicingFreq: 1200,
    voicingGainDb: 2.5,
    powerClipK: 1.8,
    cabLpHz: 5200,
    cabPeakFreq: 3400,
    cabPeakGainDb: 2,
    defaults: { gain: 55, bass: 45, mid: 55, treble: 65, presence: 65, master: 70 },
  },
};

const pctToDb = (v: number, range: number) => ((v - 50) / 50) * range;

function createAmp(ctx: AudioContext, cfg: AmpModelConfig): EffectInstance {
  const input = ctx.createGain();
  const output = ctx.createGain();

  // 前级:高通(紧实)→ preGain → 削波 → voicing
  const preHp = ctx.createBiquadFilter();
  preHp.type = 'highpass';
  preHp.frequency.value = cfg.preHpHz;
  const preGain = ctx.createGain();
  const preShaper = ctx.createWaveShaper();
  preShaper.curve = makeClipCurve(cfg.preClipK);
  preShaper.oversample = '4x';
  const voicing = ctx.createBiquadFilter();
  voicing.type = 'peaking';
  voicing.frequency.value = cfg.voicingFreq;
  voicing.Q.value = 1.1;
  voicing.gain.value = cfg.voicingGainDb;

  // 音色栈
  const bass = ctx.createBiquadFilter();
  bass.type = 'lowshelf';
  bass.frequency.value = 120;
  const mid = ctx.createBiquadFilter();
  mid.type = 'peaking';
  mid.frequency.value = 700;
  mid.Q.value = 1;
  const treble = ctx.createBiquadFilter();
  treble.type = 'highshelf';
  treble.frequency.value = 3200;
  const presence = ctx.createBiquadFilter();
  presence.type = 'highshelf';
  presence.frequency.value = 5000;

  // 后级饱和
  const powerShaper = ctx.createWaveShaper();
  powerShaper.curve = makeClipCurve(cfg.powerClipK);
  powerShaper.oversample = '2x';

  // 箱体模拟:高通去轰 + 共振峰 + 低通去刺
  const cabHp = ctx.createBiquadFilter();
  cabHp.type = 'highpass';
  cabHp.frequency.value = 75;
  const cabPeak = ctx.createBiquadFilter();
  cabPeak.type = 'peaking';
  cabPeak.frequency.value = cfg.cabPeakFreq;
  cabPeak.Q.value = 1.4;
  cabPeak.gain.value = cfg.cabPeakGainDb;
  const cabLp = ctx.createBiquadFilter();
  cabLp.type = 'lowpass';
  cabLp.frequency.value = cfg.cabLpHz;

  const masterGain = ctx.createGain();

  // 静态初始值
  const d = cfg.defaults;
  preGain.gain.value = 1 + (d.gain / 100) * (cfg.preGainMax - 1);
  bass.gain.value = pctToDb(d.bass, 12);
  mid.gain.value = pctToDb(d.mid, 12);
  treble.gain.value = pctToDb(d.treble, 12);
  presence.gain.value = (d.presence / 100) * 8;
  masterGain.gain.value = d.master / 100;

  input.connect(preHp);
  preHp.connect(preGain);
  preGain.connect(preShaper);
  preShaper.connect(voicing);
  voicing.connect(bass);
  bass.connect(mid);
  mid.connect(treble);
  treble.connect(presence);
  presence.connect(powerShaper);
  powerShaper.connect(cabHp);
  cabHp.connect(cabPeak);
  cabPeak.connect(cabLp);
  cabLp.connect(masterGain);
  masterGain.connect(output);

  return {
    input,
    output,
    update(key, value) {
      const t = ctx.currentTime;
      switch (key) {
        case 'gain':
          preGain.gain.setTargetAtTime(1 + (value / 100) * (cfg.preGainMax - 1), t, SMOOTH);
          break;
        case 'bass':
          bass.gain.setTargetAtTime(pctToDb(value, 12), t, SMOOTH);
          break;
        case 'mid':
          mid.gain.setTargetAtTime(pctToDb(value, 12), t, SMOOTH);
          break;
        case 'treble':
          treble.gain.setTargetAtTime(pctToDb(value, 12), t, SMOOTH);
          break;
        case 'presence':
          presence.gain.setTargetAtTime((value / 100) * 8, t, SMOOTH);
          break;
        case 'master':
          masterGain.gain.setTargetAtTime(value / 100, t, SMOOTH);
          break;
      }
    },
    dispose() {
      [
        input, preHp, preGain, preShaper, voicing,
        bass, mid, treble, presence, powerShaper,
        cabHp, cabPeak, cabLp, masterGain, output,
      ].forEach((n) => n.disconnect());
    },
  };
}

const AMP_PARAMS = (d: AmpModelConfig['defaults']) => [
  { key: 'gain', label: 'GAIN', min: 0, max: 100, step: 1, defaultValue: d.gain },
  { key: 'bass', label: 'BASS', min: 0, max: 100, step: 1, defaultValue: d.bass },
  { key: 'mid', label: 'MID', min: 0, max: 100, step: 1, defaultValue: d.mid },
  { key: 'treble', label: 'TREBLE', min: 0, max: 100, step: 1, defaultValue: d.treble },
  { key: 'presence', label: 'PRESENCE', min: 0, max: 100, step: 1, defaultValue: d.presence },
  { key: 'master', label: 'MASTER', min: 0, max: 100, step: 1, defaultValue: d.master },
];

function makeAmpDef(id: string, name: string, color: string): EffectDefinition {
  const cfg = AMP_MODELS[id];
  return {
    id,
    name,
    color,
    params: AMP_PARAMS(cfg.defaults),
    create: (ctx) => createAmp(ctx, cfg),
  };
}

/** 箱头目录(复用效果器接口,UI 与引擎一视同仁) */
export const AMP_REGISTRY: EffectDefinition[] = [
  makeAmpDef('clean', 'Clean Twin', '#8a8f98'),
  makeAmpDef('crunch', 'British Crunch', '#c8a24a'),
  makeAmpDef('recto', 'Modern Recto', '#b03a2e'),
  makeAmpDef('chime', 'AC Chime', '#2e8b57'),
];

export function getAmpDef(id: string): EffectDefinition {
  const def = AMP_REGISTRY.find((d) => d.id === id);
  if (!def) throw new Error(`未知箱头型号: ${id}`);
  return def;
}
