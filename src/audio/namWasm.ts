import type { EffectInstance } from './effects/types';
import { NAM_AMP_DEFAULTS } from './nam';

/**
 * NAM WASM 箱头(WaveNet 等全架构):
 * .nam 文件原文经 AudioWorklet 内的 NAM Core(emscripten 构建,见 wasm/)
 * 解析并推理;结构与 nam.ts(纯 JS LSTM 路线)一致,可对照阅读。
 *
 * 加载序列:create() 同步建 worklet → 异步初始化 wasm(init: glue+wasm 字节)
 * → 就绪后送入模型 JSON;期间 worklet 直通。换模型走结构重建(namVersion)。
 */

const WASM_BASE = `${import.meta.env.BASE_URL}nam-wasm`;
const WASM_URL = `${WASM_BASE}/nam-wasm-glue.wasm`;

/** 内置 WaveNet 模型清单(来源与许可见 public/models/ATTRIBUTION.md) */
export interface BundledNamWasmModel {
  id: string;
  name: string;
  url: string;
}

export const BUNDLED_WAVENET_MODELS: BundledNamWasmModel[] = [
  { id: 'wavenet-ac10', name: 'Vox AC10 (WaveNet)', url: `${import.meta.env.BASE_URL}models/ac10-wavenet.nam` },
  { id: 'wavenet-deluxe', name: 'Deluxe Reverb (WaveNet)', url: `${import.meta.env.BASE_URL}models/deluxe-wavenet.nam` },
];

/** .nam 文件的元数据(响度归一化与显示用,架构无关) */
export interface NamWasmMetadata {
  displayName: string;
  loudness: number | null;
}

// ---------- 资源缓存(wasm 字节与模型 JSON 全文,跨重建复用) ----------

let wasmBytesPromise: Promise<ArrayBuffer> | null = null;

function loadWasmBytes(): Promise<ArrayBuffer> {
  if (!wasmBytesPromise) {
    wasmBytesPromise = fetch(WASM_URL).then((r) => {
      if (!r.ok) throw new Error(`wasm 下载失败 HTTP ${r.status}`);
      return r.arrayBuffer();
    });
  }
  return wasmBytesPromise;
}

const modelTextCache = new Map<string, Promise<string>>();
const metadataCache = new Map<string, NamWasmMetadata>();
let currentSource = BUNDLED_WAVENET_MODELS[0].url;

/** 切换当前模型源(URL 或 loadNamWasmModelFromFile 生成的 file: 键) */
export function setNamWasmModelSource(source: string): void {
  currentSource = source;
}

function loadModelText(source: string = currentSource): Promise<string> {
  let p = modelTextCache.get(source);
  if (!p) {
    p = fetch(source).then((r) => {
      if (!r.ok) throw new Error(`模型下载失败 HTTP ${r.status}`);
      return r.text();
    });
    modelTextCache.set(source, p);
  }
  return p;
}

function parseMetadata(json: string): NamWasmMetadata {
  try {
    const j = JSON.parse(json);
    return {
      displayName: j?.metadata?.name || '未命名模型',
      loudness: typeof j?.metadata?.loudness === 'number' ? j.metadata.loudness : null,
    };
  } catch {
    return { displayName: '未命名模型', loudness: null };
  }
}

/** 从本地 .nam 文件加载(任意 NAM Core 支持的架构),成功后置为当前模型 */
export async function loadNamWasmModelFromFile(file: File): Promise<NamWasmMetadata> {
  const text = await file.text();
  const meta = parseMetadata(text);
  const key = `file:${file.name}:${file.size}:${Date.now()}`;
  modelTextCache.set(key, Promise.resolve(text));
  metadataCache.set(key, meta);
  currentSource = key;
  return meta;
}

const SMOOTH = 0.03;
const pctToDb = (v: number, range: number) => ((v - 50) / 50) * range;

/**
 * NAM WASM 箱头实例:
 *   input → drive(GAIN,输入激励)→ nam-wasm worklet(NAM Core 推理)→ normalizeGain(响度归一化)
 *         → BASS/MID/TREBLE/PRESENCE 音色栈 → masterGain → output
 * 归一化公式与官方插件 Normalized 模式一致(-18LUFS - loudness,钳制 [-12, +36]dB)。
 */
export function createNamWasmAmp(ctx: AudioContext): EffectInstance {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const drive = ctx.createGain();
  const normalizeGain = ctx.createGain();

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
  let wasmReady = false;
  input.connect(drive);
  try {
    worklet = new AudioWorkletNode(ctx, 'nam-wasm');
    drive.connect(worklet);
    worklet.connect(normalizeGain);
  } catch {
    console.warn('[nam-wasm] AudioWorklet "nam-wasm" 不可用,回退为直通(仅音色栈)');
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
    const sendModel = () => {
      const source = currentSource;
      Promise.all([loadModelText(source), loadWasmBytes]).then(([json]) => {
        if (disposed || !wasmReady) return;
        node.port.postMessage({ type: 'model', json });
        const meta = metadataCache.get(source) ?? parseMetadata(json);
        if (meta.loudness !== null) {
          const makeupDb = Math.min(36, Math.max(-12, -18 - meta.loudness));
          normalizeGain.gain.setTargetAtTime(Math.pow(10, makeupDb / 20), ctx.currentTime, SMOOTH);
          console.info(
            `[nam-wasm] 模型 "${meta.displayName}" 响度 ${meta.loudness.toFixed(1)}LUFS,归一化补偿 ${makeupDb.toFixed(1)}dB`,
          );
        }
      }).catch((e) => console.warn('[nam-wasm] 模型加载失败:', e));
    };
    node.port.onmessage = (e) => {
      const msg = e.data;
      if (msg?.type === 'ready') {
        wasmReady = true;
        console.info('[nam-wasm] wasm 模块就绪');
        sendModel();
      } else if (msg?.type === 'model-ready') {
        console.info('[nam-wasm] 模型已加载');
      } else if (msg?.type === 'nam-wasm-error') {
        console.error(`[nam-wasm] ${msg.message}`);
      }
    };
    loadWasmBytes()
      .then((bytes) => {
        if (disposed) return;
        // transfer 会detach,拷贝一份再传(缓存保留原字节供后续重建复用)
        const copy = bytes.slice(0);
        node.port.postMessage({ type: 'init', wasmBytes: copy }, [copy]);
      })
      .catch((e) => console.warn('[nam-wasm] wasm 加载失败:', e));
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
