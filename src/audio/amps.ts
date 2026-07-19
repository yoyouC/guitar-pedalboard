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

/**
 * 不对称削波曲线(JCM800 cold clipper 风格):
 * 冷偏置使负半周(cutoff 侧)很早被硬削,正半周留足空间温和软削、
 * 保留原始音乐信息。产生以二次谐波为主的"creamy"失真。
 */
function makeAsymClipCurve(): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(CURVE_LENGTH);
  let max = 0;
  for (let i = 0; i < CURVE_LENGTH; i++) {
    const x = (i / (CURVE_LENGTH - 1)) * 2 - 1;
    curve[i] = x < 0 ? Math.tanh(4.5 * x) : Math.tanh(1.1 * x);
    const a = Math.abs(curve[i]);
    if (a > max) max = a;
  }
  for (let i = 0; i < CURVE_LENGTH; i++) curve[i] /= max;
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
  defaults: { gain: number; bass: number; mid: number; treble: number; presence: number; master: number };
  /** 存在时替代通用 createAmp(如 crunch 的 JCM800 定制链路) */
  customCreate?: (ctx: AudioContext) => EffectInstance;
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
    defaults: { gain: 40, bass: 55, mid: 45, treble: 65, presence: 50, master: 55 },
  },
  crunch: {
    // Marshall Plexi/JCM800 类:中频突出、经典碎音(定制链路,见 createCrunchAmp)
    preGainMax: 40,
    preClipK: 3,
    preHpHz: 90,
    voicingFreq: 800,
    voicingGainDb: 3,
    powerClipK: 2,
    defaults: { gain: 60, bass: 50, mid: 65, treble: 60, presence: 55, master: 55 },
    customCreate: createCrunchAmp,
  },
  recto: {
    // Mesa Dual Rectifier 类:高增益、低频紧实、现代金属
    preGainMax: 35,
    preClipK: 6,
    preHpHz: 120,
    voicingFreq: 500,
    voicingGainDb: -3,
    powerClipK: 2.5,
    defaults: { gain: 70, bass: 60, mid: 40, treble: 60, presence: 60, master: 55 },
  },
  chime: {
    // Vox AC30 类:中高频“钟声”感、柔顺过载
    preGainMax: 18,
    preClipK: 2.2,
    preHpHz: 80,
    voicingFreq: 1200,
    voicingGainDb: 2.5,
    powerClipK: 1.8,
    defaults: { gain: 55, bass: 45, mid: 55, treble: 65, presence: 65, master: 55 },
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
  powerShaper.connect(masterGain);
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
        masterGain, output,
      ].forEach((n) => n.disconnect());
    },
  };
}

/**
 * British Crunch 定制链路(Plexi / JCM800 电路建模):
 *   早切低频(120Hz HP,.68uF 旁路 + .0022uF 耦合的效果)
 *   → V1B 增益级软削 → Miller 高频滚降 + 470pF bright cap 补偿
 *   → cold clipper(冷偏置,不对称削波,二次谐波为主)
 *   → 暖偏置级(保持不对称)→ 阴极跟随器
 *   → TMB 音色栈(500Hz noon 位特征凹陷)→ presence
 *   → EL34 后级 → 输出变压器带宽限制(80Hz~6.5kHz)
 *   (箱体模拟已独立为 cab 级,见 cabs.ts)
 */
function createCrunchAmp(ctx: AudioContext): EffectInstance {
  const d = AMP_MODELS.crunch.defaults;
  const input = ctx.createGain();
  const output = ctx.createGain();

  // 前级:早切低频 → 增益 → V1B 软削
  const leanHp = ctx.createBiquadFilter();
  leanHp.type = 'highpass';
  leanHp.frequency.value = 120;
  const preGain = ctx.createGain();
  const stage1 = ctx.createWaveShaper();
  stage1.curve = makeClipCurve(2);
  stage1.oversample = '4x';

  // Miller 滚降 + bright cap 补偿
  const millerLp1 = ctx.createBiquadFilter();
  millerLp1.type = 'lowpass';
  millerLp1.frequency.value = 6500;
  const brightShelf = ctx.createBiquadFilter();
  brightShelf.type = 'highshelf';
  brightShelf.frequency.value = 2500;
  brightShelf.gain.value = 3;

  // cold clipper:固定激励 + 不对称削波
  const coldDrive = ctx.createGain();
  coldDrive.gain.value = 4;
  const coldClip = ctx.createWaveShaper();
  coldClip.curve = makeAsymClipCurve();
  coldClip.oversample = '4x';

  // 暖偏置级 + 第二级 Miller 滚降 + 阴极跟随器
  const warmStage = ctx.createWaveShaper();
  warmStage.curve = makeClipCurve(1.2);
  warmStage.oversample = '4x';
  const millerLp2 = ctx.createBiquadFilter();
  millerLp2.type = 'lowpass';
  millerLp2.frequency.value = 6000;
  const cfClip = ctx.createWaveShaper();
  cfClip.curve = makeClipCurve(1.5);
  cfClip.oversample = '2x';

  // 音色栈:noon 位 500Hz 特征凹陷 + 三段控制
  const scoop = ctx.createBiquadFilter();
  scoop.type = 'peaking';
  scoop.frequency.value = 500;
  scoop.Q.value = 1;
  scoop.gain.value = -3.5;
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

  // 后级:EL34 + 输出变压器带宽
  const powerDrive = ctx.createGain();
  powerDrive.gain.value = 1.0;
  const powerClip = ctx.createWaveShaper();
  powerClip.curve = makeClipCurve(2);
  powerClip.oversample = '2x';
  const xfHp = ctx.createBiquadFilter();
  xfHp.type = 'highpass';
  xfHp.frequency.value = 80;
  const xfLp = ctx.createBiquadFilter();
  xfLp.type = 'lowpass';
  xfLp.frequency.value = 6500;

  const masterGain = ctx.createGain();

  // 静态初始值(与 defaults 一致)
  preGain.gain.value = 1 + (d.gain / 100) * 11; // 1 ~ 12
  bass.gain.value = pctToDb(d.bass, 12);
  mid.gain.value = pctToDb(d.mid, 12);
  treble.gain.value = pctToDb(d.treble, 12);
  presence.gain.value = (d.presence / 100) * 8;
  masterGain.gain.value = d.master / 100;

  const chain: AudioNode[] = [
    input, leanHp, preGain, stage1, millerLp1, brightShelf,
    coldDrive, coldClip, warmStage, millerLp2, cfClip,
    scoop, bass, mid, treble, presence,
    powerDrive, powerClip, xfHp, xfLp,
    masterGain, output,
  ];
  for (let i = 0; i < chain.length - 1; i++) chain[i].connect(chain[i + 1]);

  return {
    input,
    output,
    update(key, value) {
      const t = ctx.currentTime;
      switch (key) {
        case 'gain':
          preGain.gain.setTargetAtTime(1 + (value / 100) * 11, t, SMOOTH);
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
      chain.forEach((n) => n.disconnect());
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
    create: cfg.customCreate ?? ((ctx) => createAmp(ctx, cfg)),
  };
}

/** 箱头目录(复用效果器接口,UI 与引擎一视同仁) */
export const AMP_REGISTRY: EffectDefinition[] = [
  makeAmpDef('clean', 'Clean Twin', '#8a8f98'),
  makeAmpDef('crunch', 'British Crunch', '#c8a24a'),
  makeAmpDef('recto', 'Modern Recto', '#b03a2e'),
  makeAmpDef('chime', 'AC Chime', '#2e8b57'),
  wdfChampDef(),
];

/**
 * WDF Champ(实验):5F1 风格,两级 12AX7 WDF 共阴极级 + 单端后级。
 * AudioWorklet 实现,加载失败兜底直通。
 */
function wdfChampDef(): EffectDefinition {
  return {
    id: 'wdfchamp',
    name: 'WDF Champ ⚗',
    color: '#7d3c98',
    params: [
      { key: 'gain', label: 'GAIN', min: 0, max: 100, step: 1, defaultValue: 50 },
      { key: 'master', label: 'MASTER', min: 0, max: 100, step: 1, defaultValue: 60 },
    ],
    create(ctx: AudioContext): EffectInstance {
      const input = ctx.createGain();
      const output = ctx.createGain();
      let node: AudioWorkletNode | null = null;
      try {
        node = new AudioWorkletNode(ctx, 'wdf-champ');
        input.connect(node);
        node.connect(output);
      } catch (e) {
        console.warn('WDF Champ worklet 未就绪,直通:', e);
        input.connect(output);
      }
      return {
        input,
        output,
        update(key, value) {
          node?.parameters.get(key)?.setTargetAtTime(value, ctx.currentTime, 0.03);
        },
        dispose() {
          input.disconnect();
          node?.disconnect();
          output.disconnect();
        },
      };
    },
  };
}

export function getAmpDef(id: string): EffectDefinition {
  const def = AMP_REGISTRY.find((d) => d.id === id);
  if (!def) throw new Error(`未知箱头型号: ${id}`);
  return def;
}
