import type { EffectInstance } from './effects/types';
import { levelDbToGain } from './level';
import { BASE_URL } from './baseUrl';
import { createNamWasmVoice } from './namWasmVoice';
import { reportAmpLoad, resetAmpLoad } from './loadProgress';
import { createToneStack } from './toneStack';

/** NAM 箱头的固定 6 旋钮默认值(GAIN 50 = 单位输入激励,MASTER dB 域见 level.ts) */
export const NAM_AMP_DEFAULTS = {
  gain: 50,
  bass: 50,
  mid: 50,
  treble: 50,
  presence: 50,
  master: 0,
};

/**
 * NAM WASM 箱头(WaveNet 等全架构):
 * .nam 文件原文经 AudioWorklet 内的 NAM Core(emscripten 构建,见 wasm/)
 * 解析并推理;结构与 nam.ts(纯 JS LSTM 路线)一致,可对照阅读。
 * worklet 生命周期由 namWasmVoice.ts 统一管理(与 NAM 单块共用)。
 */

/** 内置 WaveNet 模型清单(来源与许可见 public/models/ATTRIBUTION.md;这些文件随 git 跟踪并随部署发布) */
export interface BundledNamWasmModel {
  id: string;
  name: string;
  url: string;
}

const TRACKED_WAVENET_MODELS: BundledNamWasmModel[] = [
  // 清音
  { id: 'fender-twinverb', name: 'Fender TwinVerb', url: `${BASE_URL}models/fender-twinverb.nam` },
  { id: 'peavey-5152-clean', name: '5152 Clean', url: `${BASE_URL}models/peavey-5152-clean.nam` },
  { id: 'vox-ac15', name: 'Vox AC15', url: `${BASE_URL}models/vox-ac15.nam` },
  { id: 'wavenet-ac10', name: 'Vox AC10 (WaveNet)', url: `${BASE_URL}models/ac10-wavenet.nam` },
  { id: 'wavenet-deluxe', name: 'Deluxe Reverb (WaveNet)', url: `${BASE_URL}models/deluxe-wavenet.nam` },
  { id: 'friedman-shirley-clean', name: 'Dirty Shirley Clean', url: `${BASE_URL}models/friedman-shirley-clean.nam` },
  { id: 'jcm2000-clean', name: 'JCM2000 Clean', url: `${BASE_URL}models/jcm2000-clean.nam` },
  // crunch / 中增益
  { id: 'jcm2000-crunch', name: 'JCM2000 Crunch', url: `${BASE_URL}models/jcm2000-crunch.nam` },
  { id: 'laney-gh100s', name: 'Laney GH100S Crunch', url: `${BASE_URL}models/laney-gh100s.nam` },
  { id: 'orange-rockerverb', name: 'Orange Rockerverb', url: `${BASE_URL}models/orange-rockerverb.nam` },
  { id: 'sovtek-mig50', name: 'Sovtek MIG50', url: `${BASE_URL}models/sovtek-mig50.nam` },
  // 高增益
  { id: 'jcm900-g12', name: 'JCM900 HiGain G12', url: `${BASE_URL}models/jcm900-dualverb-g12.nam` },
  { id: 'jcm900-g16', name: 'JCM900 HiGain G16', url: `${BASE_URL}models/jcm900-dualverb-g16.nam` },
  { id: 'bug1990-lead', name: 'Bug1990 Lead (JCM800系)', url: `${BASE_URL}models/bug1990-lead.nam` },
  { id: '5150-blockletter', name: '5150 Block Letter', url: `${BASE_URL}models/helga-5150-blockletter.nam` },
  { id: '6505-red', name: '6505+ Red Ch', url: `${BASE_URL}models/helga-6505-red.nam` },
  // LSTM 架构 capture(与纯 JS LSTM 引擎合并后统一由 WASM Core 运行)
  { id: 'lstm-demo', name: 'Test LSTM · Darkglass (H=3)', url: `${BASE_URL}models/lstm-demo.nam` },
  { id: 'deluxe-3x24', name: 'Deluxe Reverb 3×24 (LSTM)', url: `${BASE_URL}models/DeluxeReverb-3x24.nam` },
  { id: 'ref-2x16', name: 'Reference LSTM 2×16', url: `${BASE_URL}models/reference-lstm-2x16.nam` },
  { id: 'boss-1x16', name: 'Boss LSTM 1×16', url: `${BASE_URL}models/BossLSTM-1x16.nam` },
  { id: 'boss-2x16', name: 'Boss LSTM 2×16', url: `${BASE_URL}models/BossLSTM-2x16.nam` },
];

export const BUNDLED_WAVENET_MODELS: BundledNamWasmModel[] = TRACKED_WAVENET_MODELS;

/** .nam 文件的元数据(响度归一化与显示用,架构无关) */
export interface NamWasmMetadata {
  displayName: string;
  loudness: number | null;
}

// ---------- 资源缓存(模型 JSON 全文,跨重建复用) ----------

const modelTextCache = new Map<string, Promise<string>>();
const metadataCache = new Map<string, NamWasmMetadata>();
const TONE3000_MODEL_TEXT_CACHE_MAX = 8;

/** Tone3000 模型 key 编解码(ADR-0007):`${prefix}${toneId}`,全仓唯一字面量来源 */
export const TONE3000_KEY_PREFIX = 'tone3000:';

export function buildTone3000Key(toneId: string): string {
  return `${TONE3000_KEY_PREFIX}${toneId}`;
}

/** 解析 `tone3000:{toneId}` → toneId;非 tone3000 key 返回 null */
export function parseTone3000Key(key: string): string | null {
  return key.startsWith(TONE3000_KEY_PREFIX) ? key.slice(TONE3000_KEY_PREFIX.length) : null;
}

/**
 * NAM 模型选择(ADR-0007,评审候选 8 最小版):模型源作为数据随
 * AmpSpec/状态传递,不再经模块级全局态偷读。
 * - `{ source }`:单模型 URL 或 cache key(`file:` 本地文件、`tone3000:` 外部引用);
 * - `{ pack }`:增益扫档包。
 */
export type NamModelSelection = { source: string; modelId?: string } | { pack: NamSweepPack };

/**
 * TONE3000 模型文本提供者注册点(adapter 注册,非模型选择状态——
 * 选择状态已在 NamModelSelection 收编;这里注册的只是"如何按用户身份
 * 下载"的能力,与 createWorkletLoader 的注册语义同类)。
 * 生产由 tone3000/instance 注册;传 null 注销(测试隔离用)。
 */
type Tone3000ModelTextProvider = (toneId: string, modelId?: string) => Promise<string>;
let tone3000Provider: Tone3000ModelTextProvider | null = null;

export function setTone3000ModelTextProvider(provider: Tone3000ModelTextProvider | null): void {
  tone3000Provider = provider;
}

/** 登出/测试隔离：仅清外部 TONE3000 文本，内置与本地模型缓存不受影响。 */
export function clearTone3000ModelTextCache(): void {
  for (const key of modelTextCache.keys()) {
    if (key.startsWith(TONE3000_KEY_PREFIX)) modelTextCache.delete(key);
  }
}

function enforceTone3000ModelTextCacheLimit(): void {
  const external = [...modelTextCache.keys()].filter((key) => key.startsWith(TONE3000_KEY_PREFIX));
  while (external.length > TONE3000_MODEL_TEXT_CACHE_MAX) {
    modelTextCache.delete(external.shift()!);
  }
}

// ---------- 增益扫档包(同一箱头多个 gain 档位的 capture 组,GAIN 旋钮切档) ----------

export interface NamSweepStage {
  /** 显示用档位标签(如 '5.5' / '10') */
  gain: string;
  url: string;
}

export interface NamSweepPack {
  id: string;
  name: string;
  stages: NamSweepStage[];
}

const SWEEP_BASE = `${BASE_URL}models/marshall-sweep`;
const SWEEPS_BASE = `${BASE_URL}models`;

/** 增益扫档包(已获作者授权,见 public/models/ATTRIBUTION.md) */
export const NAM_SWEEP_PACKS: Record<string, NamSweepPack> = {
  'jcm800-sweep': {
    id: 'jcm800-sweep',
    name: 'JCM800 2203(增益扫档)',
    stages: ['g1.0', 'g2.5', 'g4.0', 'g5.5', 'g7.0', 'g8.0', 'g9.0', 'ga10'].map((g) => ({
      gain: g === 'ga10' ? '10' : g.slice(1),
      url: `${SWEEP_BASE}/jcm800-high-${g}-11.4dBu.nam`,
    })),
  },
  'bassman-sweep': {
    id: 'bassman-sweep',
    name: 'Fender Bassman 50(增益扫档)',
    stages: ['1', '2', '3', '4', '5', '6', '7', '9'].map((g) => ({
      gain: g,
      url: `${SWEEPS_BASE}/bassman-sweep/g${g}.nam`,
    })),
  },
  'dualterror-sweep': {
    id: 'dualterror-sweep',
    name: 'Orange Dual Terror(增益扫档)',
    stages: ['1', '2', '3', '4', '5', '6', '7', '9'].map((g) => ({
      gain: g,
      url: `${SWEEPS_BASE}/dualterror-sweep/g${g}.nam`,
    })),
  },
  'evh-green-sweep': {
    id: 'evh-green-sweep',
    name: 'EVH 5150 6L6 Green(增益扫档)',
    stages: ['1', '2', '3', '4', '5', '6', '8', '10'].map((g) => ({
      gain: g,
      url: `${SWEEPS_BASE}/evh-green-sweep/g${g}.nam`,
    })),
  },
  'recto-red-sweep': {
    id: 'recto-red-sweep',
    name: 'Mesa Dual Recto Red(增益扫档)',
    stages: ['2', '2.5', '4', '5', '6', '7', '8', '10'].map((g) => ({
      gain: g,
      url: `${SWEEPS_BASE}/recto-red-sweep/g${g}.nam`,
    })),
  },
};

/**
 * 按 source(URL / file: cache key / tone3000: 外部引用)取模型文本。
 * 成功结果永久缓存;**失败不缓存**——否则 tone3000: 源在未登录时的失败
 * 会让登录后的重试永远命中缓存的 rejection(刷新页面才能恢复)。
 * 导出以便测试 provider 分派(tests/nam-model-source.test.ts)。
 */
export function loadModelText(source: string, modelId?: string): Promise<string> {
  const cacheKey = modelId ? `${source}:model:${modelId}` : source;
  let p = modelTextCache.get(cacheKey);
  if (p && cacheKey.startsWith(TONE3000_KEY_PREFIX)) {
    modelTextCache.delete(cacheKey);
    modelTextCache.set(cacheKey, p);
  }
  if (!p) {
    const toneId = parseTone3000Key(source);
    if (toneId !== null) {
      // 外部模型引用:经注册的 provider(带 OAuth Bearer)按用户身份下载
      p = tone3000Provider
        ? tone3000Provider(toneId, modelId)
        : Promise.reject(new Error('TONE3000 模型提供者未注册'));
    } else {
      p = fetch(source).then((r) => {
        if (!r.ok) throw new Error(`模型下载失败 HTTP ${r.status}`);
        return r.text();
      });
    }
    modelTextCache.set(cacheKey, p);
    if (cacheKey.startsWith(TONE3000_KEY_PREFIX)) {
      p.then(enforceTone3000ModelTextCacheLimit).catch(() => {});
    }
    p.catch(() => {
      if (modelTextCache.get(cacheKey) === p) modelTextCache.delete(cacheKey);
    });
  }
  return p;
}

/**
 * .nam 元数据解析(导出供测试)。
 * A2 SlimmableContainer 形态顶层可以没有 metadata——loudness/name 挂在
 * config.submodels[] 的子模型上,默认激活的是最后一个(全尺寸)子模型
 * (见 docs/nam-a2-vs-a1.md);缺失时回退它,否则响度归一化会静默跳过。
 */
export function parseNamMetadata(json: string): NamWasmMetadata {
  try {
    const j = JSON.parse(json);
    const top = j?.metadata;
    const submodels = j?.config?.submodels;
    const fallbackSub =
      Array.isArray(submodels) && submodels.length > 0
        ? submodels[submodels.length - 1]?.metadata
        : undefined;
    const name = top?.name || fallbackSub?.name;
    const loudness =
      typeof top?.loudness === 'number'
        ? top.loudness
        : typeof fallbackSub?.loudness === 'number'
          ? fallbackSub.loudness
          : null;
    return { displayName: name || '未命名模型', loudness };
  } catch {
    return { displayName: '未命名模型', loudness: null };
  }
}

/** 从本地 .nam 文件加载(任意 NAM Core 支持的架构);返回 cache key 与元数据,由调用方收编为模型选择 */
export async function loadNamWasmModelFromFile(
  file: File,
): Promise<NamWasmMetadata & { key: string }> {
  const text = await file.text();
  const meta = parseNamMetadata(text);
  const key = `file:${file.name}:${file.size}:${Date.now()}`;
  modelTextCache.set(key, Promise.resolve(text));
  metadataCache.set(key, meta);
  return { ...meta, key };
}

const SMOOTH = 0.03;
const pctToDb = (v: number, range: number) => ((v - 50) / 50) * range;

/**
 * NAM WASM 箱头实例:
 *   input → drive(GAIN,输入激励)→ nam-wasm worklet(NAM Core 推理)→ normalizeGain(响度归一化)
 *         → BASS/MID/TREBLE/PRESENCE 音色栈 → masterGain → output
 * 归一化公式与官方插件 Normalized 模式一致(-18LUFS - loudness,钳制 [-12, +36]dB)。
 */
export function createNamWasmAmp(ctx: AudioContext, model: NamModelSelection): EffectInstance {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const drive = ctx.createGain();
  const normalizeGain = ctx.createGain();

  // 音色栈(共享模块,见 toneStack.ts;初始值在模块内按 defaults 设置)
  const tone = createToneStack(ctx, NAM_AMP_DEFAULTS);
  const masterGain = ctx.createGain();

  const d = NAM_AMP_DEFAULTS;
  drive.gain.value = Math.pow(10, pctToDb(d.gain, 12) / 20);
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
  normalizeGain.connect(tone.input);
  tone.output.connect(masterGain);
  masterGain.connect(output);

  // ---------- 扫档包模式:GAIN 旋钮在预载档位间瞬时切换 ----------
  const pack = 'pack' in model ? model.pack : null;
  const stages = pack?.stages ?? [];
  const stageLoudness: (number | null)[] = stages.map(() => null);
  const slotReady = new Set<number>();
  let activeIdx = -1;
  // 目标档位:参数回放(GAIN)在槽位就绪前到达时记录于此,就绪即激活
  let desiredIdx = pack
    ? Math.min(stages.length - 1, Math.floor((NAM_AMP_DEFAULTS.gain / 100) * stages.length))
    : -1;
  const applyStageLevel = (idx: number) => {
    const l = stageLoudness[idx];
    if (l !== null && l !== undefined) {
      const makeupDb = Math.min(36, Math.max(-12, -18 - l));
      normalizeGain.gain.setTargetAtTime(Math.pow(10, makeupDb / 20), ctx.currentTime, SMOOTH);
    }
  };

  if (voice && pack) {
    drive.gain.value = 1; // 扫档包:输入激励固定 unity,GAIN 旋钮用于切档
    // 预载全部档位(串行;每档 setDsp ~0.2-0.5s,一次性支付,之后切档零成本)
    reportAmpLoad({ phase: 'loading', done: 0, total: stages.length, label: `${pack.name} 初始化` });
    (async () => {
      for (let i = 0; i < stages.length; i++) {
        if (disposed) return;
        try {
          const json = await loadModelText(stages[i].url);
          if (disposed) return;
          stageLoudness[i] = parseNamMetadata(json).loudness;
          const waiter = voice.stageReady(i);
          voice.stageLoad(i, json, false);
          await waiter;
          slotReady.add(i);
          if (i === desiredIdx) {
            activeIdx = i;
            voice.stageActive(i);
            applyStageLevel(i);
            console.info(`[nam-wasm] 激活档位 g${stages[i].gain}`);
          }
          reportAmpLoad({ phase: 'loading', done: i + 1, total: stages.length, label: `预载 g${stages[i].gain}` });
          console.info(`[nam-wasm] 扫档预载 ${i + 1}/${stages.length} (g${stages[i].gain})`);
        } catch (e) {
          console.warn(`[nam-wasm] 扫档档位 g${stages[i].gain} 加载失败:`, e);
        }
      }
      if (!disposed) reportAmpLoad({ phase: 'ready', done: stages.length, total: stages.length, label: '' });
    })();
  } else if (voice) {
    reportAmpLoad({ phase: 'loading', done: 0, total: 2, label: '加载模型' });
    const source = 'source' in model ? model.source : BUNDLED_WAVENET_MODELS[0].url;
    const modelId = 'source' in model ? model.modelId : undefined;
    loadModelText(source, modelId)
      .then((json) => {
        if (disposed) return;
        reportAmpLoad({ phase: 'loading', done: 1, total: 2, label: '装载模型' });
        voice.sendModel(json);
        const metadataKey = modelId ? `${source}:model:${modelId}` : source;
        const meta = metadataCache.get(metadataKey) ?? parseNamMetadata(json);
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
        // 槽位 0 真正装载完毕才置 ready
        voice
          .stageReady(0)
          .then(() => {
            if (!disposed) reportAmpLoad({ phase: 'ready', done: 2, total: 2, label: '' });
          })
          .catch(() => {});
      })
      .catch((e) => console.warn('[nam-wasm] 模型加载失败:', e));
  }

  return {
    input,
    output,
    update(key, value) {
      const t = ctx.currentTime;
      switch (key) {
        case 'gain':
          if (pack) {
            // 扫档包:GAIN = 档位选择;槽位未就绪时记入 desiredIdx,预载到位即激活
            const idx = Math.min(stages.length - 1, Math.floor((value / 100) * stages.length));
            desiredIdx = idx;
            if (idx !== activeIdx && slotReady.has(idx)) {
              activeIdx = idx;
              voice?.stageActive(idx);
              applyStageLevel(idx);
              console.info(`[nam-wasm] 增益档位 → g${stages[idx].gain}`);
            }
          } else {
            drive.gain.setTargetAtTime(Math.pow(10, pctToDb(value, 12) / 20), t, SMOOTH);
          }
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
      disposed = true;
      voice?.dispose();
      resetAmpLoad();
      [input, drive, normalizeGain, ...tone.nodes, masterGain, output].forEach((n) =>
        n?.disconnect(),
      );
    },
  };
}
