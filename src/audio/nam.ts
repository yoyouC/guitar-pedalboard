import type { EffectInstance } from './effects/types';

/**
 * Neural Amp Modeler(LSTM 架构)支持:
 * 解析 .nam 文件 → 权重送入 'nam-lstm' AudioWorklet 做逐样本推理。
 *
 * 旋钮语义(NAM 是快照模型,原 capture 不含旋钮):
 *   GAIN    → 模型输入激励(input drive,±12dB,50 为单位增益)
 *   BASS/MID/TREBLE/PRESENCE → 模型之后的 biquad 音色栈
 *   MASTER  → 输出电平
 *
 * 参考: .nam 文件格式 https://neural-amp-modeler.readthedocs.io/en/latest/model-file.html
 * 权重布局: NeuralAmpModelerCore NAM/lstm.cpp(见 namProcessor.js 头部注释)
 */

/** 解析后的 NAM LSTM 模型 */
export interface NamModel {
  displayName: string;
  inputSize: number;
  hiddenSize: number;
  numLayers: number;
  sampleRate: number | null;
  /** metadata.loudness(标准化输入下的输出响度,LUFS),用于输出归一化 */
  loudness: number | null;
  /** 展平权重,布局与 NAM Core C++ 一致(见 namProcessor.js) */
  weights: Float32Array;
}

/** 与 C++ 构造逻辑一致的权重总数:in_l = 第 0 层 inputSize,其余 H;每层 4H·(in+H)+4H+2H,末尾 H+1 */
function expectedWeightCount(inputSize: number, H: number, L: number): number {
  let total = 0;
  for (let l = 0; l < L; l++) {
    const inSize = l === 0 ? inputSize : H;
    total += 4 * H * (inSize + H) + 4 * H + 2 * H;
  }
  return total + H + 1;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseNamModel(json: any): NamModel {
  if (json?.architecture !== 'LSTM') {
    throw new Error(
      `仅支持 LSTM 架构的 .nam 模型(该文件为 ${json?.architecture ?? '未知'};WaveNet 模型需要 WASM 方案)`,
    );
  }
  const cfg = json.config ?? {};
  const inputSize = cfg.input_size ?? 1;
  const hiddenSize = cfg.hidden_size;
  const numLayers = cfg.num_layers ?? 1;
  if (!Number.isInteger(hiddenSize) || hiddenSize <= 0) {
    throw new Error('模型 config 缺少有效的 hidden_size');
  }
  if (!Number.isInteger(inputSize) || inputSize <= 0 || !Number.isInteger(numLayers) || numLayers <= 0) {
    throw new Error('模型 config 的 input_size/num_layers 无效');
  }
  if ((cfg.in_channels ?? 1) !== 1 || (cfg.out_channels ?? 1) !== 1) {
    throw new Error('仅支持单声道(in_channels=out_channels=1)模型');
  }
  if (!Array.isArray(json.weights)) throw new Error('模型缺少 weights 数组');
  const weights = new Float32Array(json.weights);
  const expected = expectedWeightCount(inputSize, hiddenSize, numLayers);
  if (weights.length !== expected) {
    throw new Error(`权重数量与 config 不符: 期望 ${expected}, 实际 ${weights.length}`);
  }
  // Python 端导出若带 head_scale,折入末尾 head 权重与偏置(C++ 端不读该字段)
  const headScale = cfg.head_scale ?? 1;
  if (headScale !== 1) {
    for (let i = weights.length - hiddenSize - 1; i < weights.length; i++) {
      weights[i] *= headScale;
    }
  }
  return {
    displayName: json.metadata?.name || '未命名模型',
    inputSize,
    hiddenSize,
    numLayers,
    sampleRate: typeof json.sample_rate === 'number' ? json.sample_rate : null,
    loudness: typeof json.metadata?.loudness === 'number' ? json.metadata.loudness : null,
    weights,
  };
}

const DEFAULT_MODEL_URL = `${import.meta.env.BASE_URL}models/lstm-demo.nam`;

/** 内置模型清单(来源与许可见 public/models/ATTRIBUTION.md) */
export interface BundledNamModel {
  id: string;
  name: string;
  url: string;
}

export const BUNDLED_NAM_MODELS: BundledNamModel[] = [
  { id: 'lstm-demo', name: 'Test LSTM · Darkglass (H=3)', url: DEFAULT_MODEL_URL },
  { id: 'boss-1x16', name: 'Boss LSTM 1×16', url: `${import.meta.env.BASE_URL}models/BossLSTM-1x16.nam` },
  { id: 'boss-2x16', name: 'Boss LSTM 2×16', url: `${import.meta.env.BASE_URL}models/BossLSTM-2x16.nam` },
  { id: 'deluxe-3x24', name: 'Deluxe Reverb 3×24', url: `${import.meta.env.BASE_URL}models/DeluxeReverb-3x24.nam` },
  { id: 'ref-2x16', name: 'Reference LSTM 2×16', url: `${import.meta.env.BASE_URL}models/reference-lstm-2x16.nam` },
];

const cache = new Map<string, Promise<NamModel>>();
let currentSource = DEFAULT_MODEL_URL;

/** 切换当前模型源(URL 或 loadNamModelFromFile 生成的 file: 键) */
export function setNamModelSource(source: string): void {
  currentSource = source;
}

export function loadNamModel(source: string = currentSource): Promise<NamModel> {
  let p = cache.get(source);
  if (!p) {
    p = fetch(source)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(parseNamModel);
    cache.set(source, p);
  }
  return p;
}

/** 从本地 .nam 文件加载,成功后置为当前模型(返回模型信息供 UI 展示) */
export async function loadNamModelFromFile(file: File): Promise<NamModel> {
  const model = parseNamModel(JSON.parse(await file.text()));
  const key = `file:${file.name}:${file.size}:${Date.now()}`;
  cache.set(key, Promise.resolve(model));
  currentSource = key;
  return model;
}

const SMOOTH = 0.03;
const pctToDb = (v: number, range: number) => ((v - 50) / 50) * range;

/** NAM 箱头的固定 6 旋钮默认值(GAIN 50 = 单位输入激励) */
export const NAM_AMP_DEFAULTS = {
  gain: 50,
  bass: 50,
  mid: 50,
  treble: 50,
  presence: 50,
  master: 55,
};

/**
 * NAM LSTM 箱头实例:
 *   input → drive(GAIN,模型输入激励)→ nam-lstm worklet → normalizeGain(响度归一化)
 *         → BASS/MID/TREBLE/PRESENCE 音色栈 → masterGain → output
 * worklet 未加载时兜底为直通(保留音色栈);模型异步就绪后经 port 热更新。
 * 归一化对齐官方插件默认的 "Normalized" 输出模式:makeup(dB) = -18LUFS - metadata.loudness,
 * 无 loudness 元数据时不做归一化(增益 1)。
 */
export function createNamAmp(ctx: AudioContext): EffectInstance {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const drive = ctx.createGain();
  const normalizeGain = ctx.createGain(); // 默认 1,模型就绪后按 loudness 设定

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
  const masterGain = ctx.createGain();

  const d = NAM_AMP_DEFAULTS;
  drive.gain.value = Math.pow(10, pctToDb(d.gain, 12) / 20);
  bass.gain.value = pctToDb(d.bass, 12);
  mid.gain.value = pctToDb(d.mid, 12);
  treble.gain.value = pctToDb(d.treble, 12);
  presence.gain.value = (d.presence / 100) * 8;
  masterGain.gain.value = d.master / 100;

  let worklet: AudioWorkletNode | null = null;
  let disposed = false;
  input.connect(drive);
  try {
    worklet = new AudioWorkletNode(ctx, 'nam-lstm');
    worklet.port.onmessage = (e) => {
      const msg = e.data;
      if (msg?.type === 'model-ready') {
        console.info(`[nam] worklet 模型就绪 (hidden=${msg.hiddenSize})`);
      } else if (msg?.type === 'nam-error') {
        console.error(`[nam] worklet 错误: ${msg.message}`);
      }
    };
    drive.connect(worklet);
    worklet.connect(normalizeGain);
  } catch {
    console.warn('[nam] AudioWorklet "nam-lstm" 不可用,回退为直通(仅音色栈)');
    drive.connect(normalizeGain);
  }
  normalizeGain.connect(bass);
  bass.connect(mid);
  mid.connect(treble);
  treble.connect(presence);
  presence.connect(masterGain);
  masterGain.connect(output);

  if (worklet) {
    const node = worklet;
    loadNamModel()
      .then((m) => {
        if (disposed) return;
        if (m.sampleRate && Math.abs(m.sampleRate - ctx.sampleRate) > 1) {
          console.warn(
            `[nam] 模型采样率 ${m.sampleRate}Hz 与 AudioContext ${ctx.sampleRate}Hz 不一致,音色/音高可能有偏差`,
          );
        }
        // 响度归一化(同官方插件 Normalized 模式):目标 -18LUFS
        if (m.loudness !== null) {
          const makeupDb = Math.min(36, Math.max(-12, -18 - m.loudness));
          normalizeGain.gain.setTargetAtTime(Math.pow(10, makeupDb / 20), ctx.currentTime, SMOOTH);
          console.info(
            `[nam] 模型 "${m.displayName}" 响度 ${m.loudness.toFixed(1)}LUFS,归一化补偿 ${makeupDb.toFixed(1)}dB`,
          );
        }
        node.port.postMessage({
          type: 'model',
          inputSize: m.inputSize,
          hiddenSize: m.hiddenSize,
          numLayers: m.numLayers,
          weights: m.weights,
        });
      })
      .catch((e) => console.warn('[nam] 模型加载失败:', e));
  }

  return {
    input,
    output,
    update(key, value) {
      const t = ctx.currentTime;
      switch (key) {
        case 'gain':
          drive.gain.setTargetAtTime(Math.pow(10, pctToDb(value, 12) / 20), t, SMOOTH);
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
      disposed = true;
      if (worklet) {
        // 通知处理器停止渲染(返回 false),防止僵尸 worklet 空转音频线程
        try {
          worklet.port.postMessage({ type: 'suspend' });
          worklet.port.onmessage = null;
        } catch {
          /* 端口已关闭 */
        }
      }
      [input, drive, worklet, normalizeGain, bass, mid, treble, presence, masterGain, output].forEach(
        (n) => n?.disconnect(),
      );
    },
  };
}
