import type { EffectDefinition, EffectInstance } from './effects/types';
import { createNamWasmAmp, NAM_AMP_DEFAULTS, BUNDLED_WAVENET_MODELS, type NamModelSelection } from './namWasm';
import { LEVEL_DB_MAX, LEVEL_DB_MIN, levelDbToGain } from './level';
import { createToneStack } from './toneStack';
import { wdfTwinDef } from './wdf/twinAmpDef';
import { wdfAc30Def } from './wdf/ac30AmpDef';
import { wdfJc120Def } from './wdf/jc120AmpDef';

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
    defaults: { gain: 40, bass: 55, mid: 45, treble: 65, presence: 50, master: -14.5 },
  },
  crunch: {
    // Marshall Plexi/JCM800 类:中频突出、经典碎音(定制链路,见 createCrunchAmp)
    preGainMax: 40,
    preClipK: 3,
    preHpHz: 90,
    voicingFreq: 800,
    voicingGainDb: 3,
    powerClipK: 2,
    defaults: { gain: 60, bass: 50, mid: 65, treble: 60, presence: 55, master: -20.5 },
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
    defaults: { gain: 70, bass: 60, mid: 40, treble: 60, presence: 60, master: -20 },
  },
  chime: {
    // Vox AC30 类:中高频“钟声”感、柔顺过载
    preGainMax: 18,
    preClipK: 2.2,
    preHpHz: 80,
    voicingFreq: 1200,
    voicingGainDb: 2.5,
    powerClipK: 1.8,
    defaults: { gain: 55, bass: 45, mid: 55, treble: 65, presence: 65, master: -19.5 },
  },
};

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

  // 音色栈(共享模块,见 toneStack.ts;pin:tests/tone-stack.test.ts)
  const tone = createToneStack(ctx, cfg.defaults);

  // 后级饱和
  const powerShaper = ctx.createWaveShaper();
  powerShaper.curve = makeClipCurve(cfg.powerClipK);
  powerShaper.oversample = '2x';

  const masterGain = ctx.createGain();

  // 静态初始值
  const d = cfg.defaults;
  preGain.gain.value = 1 + (d.gain / 100) * (cfg.preGainMax - 1);
  masterGain.gain.value = levelDbToGain(d.master);

  input.connect(preHp);
  preHp.connect(preGain);
  preGain.connect(preShaper);
  preShaper.connect(voicing);
  voicing.connect(tone.input);
  tone.output.connect(powerShaper);
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
        case 'mid':
        case 'treble':
        case 'presence':
          tone.update(key, value);
          break;
        case 'master':
          masterGain.gain.setTargetAtTime(levelDbToGain(value), t, SMOOTH);
          break;
      }
    },
    dispose() {
      [
        input, preHp, preGain, preShaper, voicing,
        ...tone.nodes, powerShaper,
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

  // 音色栈:noon 位 500Hz 特征凹陷 + 共享四段栈(见 toneStack.ts)
  const scoop = ctx.createBiquadFilter();
  scoop.type = 'peaking';
  scoop.frequency.value = 500;
  scoop.Q.value = 1;
  scoop.gain.value = -3.5;
  const tone = createToneStack(ctx, d);

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

  // 静态初始值(与 defaults 一致;音色栈初始值在 createToneStack 内设置)
  preGain.gain.value = 1 + (d.gain / 100) * 11; // 1 ~ 12
  masterGain.gain.value = levelDbToGain(d.master);

  const chain: AudioNode[] = [
    input, leanHp, preGain, stage1, millerLp1, brightShelf,
    coldDrive, coldClip, warmStage, millerLp2, cfClip,
    scoop, ...tone.nodes,
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
        case 'mid':
        case 'treble':
        case 'presence':
          tone.update(key, value);
          break;
        case 'master':
          masterGain.gain.setTargetAtTime(levelDbToGain(value), t, SMOOTH);
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
  { key: 'master', label: 'MASTER', min: LEVEL_DB_MIN, max: LEVEL_DB_MAX, step: 0.5, defaultValue: d.master, unit: 'dB' },
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
  wdfBognerDef(),
  wdfTwinDef(),
  wdfAc30Def(),
  wdfJc120Def(),
  // NAM 箱头(见 namWasm.ts):NAM Core WASM 全架构(WaveNet/LSTM/…)
  // 注册表条目携带默认模型选择;实际选择经 getNamWasmAmpDef 的 memoized 工厂
  {
    id: 'nam-wasm',
    name: 'NAM WaveNet',
    color: '#2e5a8b',
    params: AMP_PARAMS(NAM_AMP_DEFAULTS),
    create: (ctx) => createNamWasmAmp(ctx, { source: BUNDLED_WAVENET_MODELS[0].url }),
  },
];

/**
 * 选择感知的 NAM 箱头 def 工厂(ADR-0007):同一模型选择返回同一 def 实例
 * —— graphBuilder 的 def+key 复用语义因此成立(选模型 = 换 def = 重建,
 * 未选模型 = 同一 def = 复用实例不重复加载模型)。
 */
const namDefCache = new Map<string, EffectDefinition>();
/** 上限防御(file: 键含时间戳、tone3000: 每 tone 一键,防长期无界增长) */
const NAM_DEF_CACHE_MAX = 32;

export function getNamWasmAmpDef(model: NamModelSelection): EffectDefinition {
  const cacheKey =
    'pack' in model
      ? `pack:${model.pack.id}`
      : `src:${model.source}${model.modelId ? `:model:${model.modelId}` : ''}`;
  let def = namDefCache.get(cacheKey);
  if (!def) {
    if (namDefCache.size >= NAM_DEF_CACHE_MAX) {
      namDefCache.delete(namDefCache.keys().next().value!);
    }
    def = {
      id: 'nam-wasm',
      name: 'NAM WaveNet',
      color: '#2e5a8b',
      params: AMP_PARAMS(NAM_AMP_DEFAULTS),
      create: (ctx) => createNamWasmAmp(ctx, model),
    };
    namDefCache.set(cacheKey, def);
  }
  return def;
}

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
      { key: 'master', label: 'MASTER', min: LEVEL_DB_MIN, max: LEVEL_DB_MAX, step: 0.5, defaultValue: -6, unit: 'dB' },
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
      // 初始 master(dB 域 → 线性)
      node?.parameters.get('master')?.setValueAtTime(levelDbToGain(-6), ctx.currentTime);
      return {
        input,
        output,
        update(key, value) {
          const t = ctx.currentTime;
          if (key === 'master') {
            node?.parameters.get('master')?.setTargetAtTime(levelDbToGain(value), t, 0.03);
          } else {
            node?.parameters.get(key)?.setTargetAtTime(value, t, 0.03);
          }
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

/**
 * WDF Bogner(实验):Ecstasy 高增益通道风格,三级 12AX7 级联(含冷偏置级)
 * + EL34 后级。worklet 负责 WDF 前级/后级与 GAIN;音色栈/MASTER 用原生节点。
 */
function wdfBognerDef(): EffectDefinition {
  const DEFAULTS = { gain: 55, bass: 50, mid: 60, treble: 60, presence: 55, master: -6 };
  return {
    id: 'wdfbogner',
    name: 'WDF Bogner ⚗',
    color: '#1c1c1e',
    params: [
      { key: 'gain', label: 'GAIN', min: 0, max: 100, step: 1, defaultValue: DEFAULTS.gain },
      { key: 'bass', label: 'BASS', min: 0, max: 100, step: 1, defaultValue: DEFAULTS.bass },
      { key: 'mid', label: 'MID', min: 0, max: 100, step: 1, defaultValue: DEFAULTS.mid },
      { key: 'treble', label: 'TREBLE', min: 0, max: 100, step: 1, defaultValue: DEFAULTS.treble },
      { key: 'presence', label: 'PRESENCE', min: 0, max: 100, step: 1, defaultValue: DEFAULTS.presence },
      { key: 'master', label: 'MASTER', min: LEVEL_DB_MIN, max: LEVEL_DB_MAX, step: 0.5, defaultValue: DEFAULTS.master, unit: 'dB' },
    ],
    create(ctx: AudioContext): EffectInstance {
      const input = ctx.createGain();
      const output = ctx.createGain();

      let node: AudioWorkletNode | null = null;
      // Bogner 中频前置 voicing
      const voicing = ctx.createBiquadFilter();
      voicing.type = 'peaking';
      voicing.frequency.value = 800;
      voicing.Q.value = 1.1;
      voicing.gain.value = 2.5;
      // 音色栈(共享模块,见 toneStack.ts)
      const tone = createToneStack(ctx, DEFAULTS);
      const masterGain = ctx.createGain();

      masterGain.gain.value = levelDbToGain(DEFAULTS.master);

      try {
        node = new AudioWorkletNode(ctx, 'wdf-bogner');
        input.connect(node);
        node.connect(voicing);
      } catch (e) {
        console.warn('WDF Bogner worklet 未就绪,直通:', e);
        input.connect(voicing);
      }
      voicing.connect(tone.input);
      tone.output.connect(masterGain);
      masterGain.connect(output);

      return {
        input,
        output,
        update(key, value) {
          const t = ctx.currentTime;
          switch (key) {
            case 'gain':
              node?.parameters.get('gain')?.setTargetAtTime(value, t, 0.03);
              break;
            case 'bass':
            case 'mid':
            case 'treble':
            case 'presence':
              tone.update(key, value);
              break;
            case 'master':
              masterGain.gain.setTargetAtTime(levelDbToGain(value), t, 0.03);
              break;
          }
        },
        dispose() {
          [input, node, voicing, ...tone.nodes, masterGain, output]
            .forEach((n) => n?.disconnect());
        },
      };
    },
  };
}
