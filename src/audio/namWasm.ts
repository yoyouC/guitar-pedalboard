import type { EffectInstance } from './effects/types';
import { levelDbToGain } from './level';
import { NAM_AMP_DEFAULTS } from './nam';
import { createNamWasmVoice } from './namWasmVoice';

/**
 * NAM WASM 箱头(WaveNet 等全架构):
 * .nam 文件原文经 AudioWorklet 内的 NAM Core(emscripten 构建,见 wasm/)
 * 解析并推理;结构与 nam.ts(纯 JS LSTM 路线)一致,可对照阅读。
 * worklet 生命周期由 namWasmVoice.ts 统一管理(与 NAM 单块共用)。
 */

/** 内置 WaveNet 模型清单(来源与许可见 public/models/ATTRIBUTION.md) */
export interface BundledNamWasmModel {
  id: string;
  name: string;
  url: string;
}

export const BUNDLED_WAVENET_MODELS: BundledNamWasmModel[] = [
  { id: 'wavenet-ac10', name: 'Vox AC10 (WaveNet)', url: `${import.meta.env.BASE_URL}models/ac10-wavenet.nam` },
  { id: 'wavenet-deluxe', name: 'Deluxe Reverb (WaveNet)', url: `${import.meta.env.BASE_URL}models/deluxe-wavenet.nam` },
  { id: 'jcm2000-clean', name: 'JCM2000 Clean', url: `${import.meta.env.BASE_URL}models/jcm2000-clean.nam` },
  { id: 'jcm2000-crunch', name: 'JCM2000 Crunch', url: `${import.meta.env.BASE_URL}models/jcm2000-crunch.nam` },
  { id: 'jcm900-g12', name: 'JCM900 HiGain G12', url: `${import.meta.env.BASE_URL}models/jcm900-dualverb-g12.nam` },
  { id: 'jcm900-g16', name: 'JCM900 HiGain G16', url: `${import.meta.env.BASE_URL}models/jcm900-dualverb-g16.nam` },
];

/** .nam 文件的元数据(响度归一化与显示用,架构无关) */
export interface NamWasmMetadata {
  displayName: string;
  loudness: number | null;
}

// ---------- 资源缓存(模型 JSON 全文,跨重建复用) ----------

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
  masterGain.gain.value = levelDbToGain(d.master);

  let disposed = false;
  input.connect(drive);
  const voice = createNamWasmVoice(ctx);
  if (voice) {
    drive.connect(voice.node);
    voice.node.connect(normalizeGain);
  } else {
    console.warn('[nam-wasm] AudioWorklet "nam-wasm" 不可用,回退为直通(仅音色栈)');
    drive.connect(normalizeGain);
  }
  normalizeGain.connect(bass);
  bass.connect(mid);
  mid.connect(treble);
  treble.connect(presence);
  presence.connect(masterGain);
  masterGain.connect(output);

  if (voice) {
    voice.ready
      .then(() => {
        if (disposed) return;
        const source = currentSource;
        loadModelText(source)
          .then((json) => {
            if (disposed) return;
            voice.sendModel(json);
            const meta = metadataCache.get(source) ?? parseMetadata(json);
            if (meta.loudness !== null) {
              const makeupDb = Math.min(36, Math.max(-12, -18 - meta.loudness));
              normalizeGain.gain.setTargetAtTime(
                Math.pow(10, makeupDb / 20),
                ctx.currentTime,
                SMOOTH,
              );
              console.info(
                `[nam-wasm] 模型 "${meta.displayName}" 响度 ${meta.loudness.toFixed(1)}LUFS,归一化补偿 ${makeupDb.toFixed(1)}dB`,
              );
            }
          })
          .catch((e) => console.warn('[nam-wasm] 模型加载失败:', e));
      })
      .catch(() => {});
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
          masterGain.gain.setTargetAtTime(levelDbToGain(value), t, SMOOTH);
          break;
      }
    },
    dispose() {
      disposed = true;
      voice?.dispose();
      [input, drive, normalizeGain, bass, mid, treble, presence, masterGain, output].forEach((n) =>
        n?.disconnect(),
      );
    },
  };
}
