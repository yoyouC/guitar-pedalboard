import type { EffectDefinition, EffectInstance } from './types';
import { LEVEL_DB_MAX, LEVEL_DB_MIN, levelDbToGain } from '../level';
import { createNamWasmVoice } from '../namWasmVoice';

/**
 * NAM 单块(NAMKnobs 条件化 capture):
 * 旋钮值作为恒定条件通道(ch1..N)随音频一同送入模型,模型在 WASM
 * AudioWorklet 内运行(与 NAM 箱头共用 namWasmVoice)。
 *
 * 模型来自 drockthedoc/NAMKnobs 的 upstream_v2(本地评估用,无再分发许可,
 * 见 public/models/ATTRIBUTION.md);v2 设计里 Level/Volume 为网络外确定增益,
 * 对应这里的 LEVEL 旋钮(dB 域,见 level.ts)。
 */

interface NamPedalConfig {
  modelUrl: string;
  /** 网络条件通道顺序(与模型 metadata.controls 一致) */
  controls: string[];
  labels: Record<string, string>;
  /** 各条件旋钮默认值(0..1,训练范围中点) */
  defaults: Record<string, number>;
}

const modelTextCache = new Map<string, Promise<string>>();

function loadPedalModel(url: string): Promise<string> {
  let p = modelTextCache.get(url);
  if (!p) {
    p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`模型下载失败 HTTP ${r.status}`);
      return r.text();
    });
    modelTextCache.set(url, p);
  }
  return p;
}

const SMOOTH = 0.03;

function createNamPedal(ctx: AudioContext, cfg: NamPedalConfig): EffectInstance {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const levelGain = ctx.createGain();
  levelGain.gain.value = levelDbToGain(0);

  const cond = cfg.controls.map((k) => cfg.defaults[k] ?? 0.5);
  let disposed = false;

  const voice = createNamWasmVoice(ctx);
  if (voice) {
    input.connect(voice.node);
    voice.node.connect(levelGain);
  } else {
    console.warn('[nam-pedal] AudioWorklet "nam-wasm" 不可用,回退为直通');
    input.connect(levelGain);
  }
  levelGain.connect(output);

  if (voice) {
    voice.setConditioning(cond);
    voice.ready
      .then(() => {
        if (disposed) return;
        loadPedalModel(cfg.modelUrl)
          .then((json) => {
            if (!disposed) voice.sendModel(json);
          })
          .catch((e) => console.warn('[nam-pedal] 模型加载失败:', e));
      })
      .catch(() => {});
  }

  return {
    input,
    output,
    update(key: string, value: number) {
      if (key === 'level') {
        levelGain.gain.setTargetAtTime(levelDbToGain(value), ctx.currentTime, SMOOTH);
        return;
      }
      const i = cfg.controls.indexOf(key);
      if (i >= 0) {
        cond[i] = value;
        voice?.setConditioning(cond);
      }
    },
    dispose() {
      disposed = true;
      voice?.dispose();
      [input, levelGain, output].forEach((n) => n.disconnect());
    },
  };
}

const NAMKNOBS = `${import.meta.env.BASE_URL}models/namknobs`;

function makeNamPedalDef(id: string, name: string, color: string, cfg: NamPedalConfig): EffectDefinition {
  return {
    id,
    name,
    color,
    params: [
      ...cfg.controls.map((k) => ({
        key: k,
        label: cfg.labels[k] ?? k.toUpperCase(),
        min: 0,
        max: 1,
        step: 0.01,
        defaultValue: cfg.defaults[k] ?? 0.5,
      })),
      { key: 'level', label: 'LEVEL', min: LEVEL_DB_MIN, max: LEVEL_DB_MAX, step: 0.5, defaultValue: 0, unit: 'dB' },
    ],
    create: (ctx: AudioContext) => createNamPedal(ctx, cfg),
  };
}

/** NAMKnobs upstream_v2 条件化单块(本地评估用) */
export const NAM_PEDAL_EFFECTS: EffectDefinition[] = [
  makeNamPedalDef('namComp', 'NAM Comp', '#2e8b57', {
    modelUrl: `${NAMKNOBS}/comp.nam`,
    controls: ['threshold', 'ratio', 'attack', 'release'],
    labels: { threshold: 'THRESH', ratio: 'RATIO', attack: 'ATTACK', release: 'RELEASE' },
    defaults: { threshold: 0.5, ratio: 0.5, attack: 0.5, release: 0.5 },
  }),
  makeNamPedalDef('namTs', 'NAM TS', '#3f7a3f', {
    modelUrl: `${NAMKNOBS}/ts_full.nam`,
    controls: ['drive', 'tone'],
    labels: { drive: 'DRIVE', tone: 'TONE' },
    defaults: { drive: 0.5, tone: 0.5 },
  }),
  makeNamPedalDef('namRat', 'NAM RAT', '#5a5a5a', {
    modelUrl: `${NAMKNOBS}/rat.nam`,
    controls: ['distortion', 'filter'],
    labels: { distortion: 'DIST', filter: 'FILTER' },
    defaults: { distortion: 0.5, filter: 0.5 },
  }),
  makeNamPedalDef('namDs1', 'NAM DS-1', '#c8842a', {
    modelUrl: `${NAMKNOBS}/ds1.nam`,
    controls: ['dist', 'tone'],
    labels: { dist: 'DIST', tone: 'TONE' },
    defaults: { dist: 0.5, tone: 0.5 },
  }),
  makeNamPedalDef('namFf', 'NAM FuzzFace', '#8a4a8a', {
    modelUrl: `${NAMKNOBS}/ff.nam`,
    controls: ['fuzz'],
    labels: { fuzz: 'FUZZ' },
    defaults: { fuzz: 0.5 },
  }),
  makeNamPedalDef('namGr', 'NAM GreenMuff', '#4a6b3a', {
    modelUrl: `${NAMKNOBS}/gr.nam`,
    controls: ['sustain', 'tone'],
    labels: { sustain: 'SUSTAIN', tone: 'TONE' },
    defaults: { sustain: 0.5, tone: 0.5 },
  }),
  makeNamPedalDef('namMxr', 'NAM Dist+', '#b03a2e', {
    modelUrl: `${NAMKNOBS}/mxr.nam`,
    controls: ['distortion'],
    labels: { distortion: 'DIST' },
    defaults: { distortion: 0.5 },
  }),
];
