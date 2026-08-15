/**
 * rigStore:Rig 状态的单一事实源(ADR-0002)。
 *
 * 模块级 pub-sub store,工厂形态 `createRigStore(engine)`:
 * - 小 interface(getState / subscribe + 一组 verb)藏住"rig 状态 ⇆ 引擎 ⇆ localStorage"的全部同步;
 * - audioEngine 是 rigStore 的被动投影:verb 内部统一"改状态 + 同步引擎",
 *   结构变化(增删/排序/开关/前后置/换箱头箱体/bypass)在 verb 内直接触发图谱重建并自增 graphVersion;
 * - 快照、预设、URL 分享三条恢复路径合一为 applyRig(各自先规范化成 ApplyRigState)。
 *
 * 本模块不依赖 React / AudioEngine 具体实现(引擎经 RigEngine 结构化类型注入),
 * 因此可在 node 下用 stub engine 直接测试(见 tests/rig-store.test.ts)。
 * 生产单例与 React 绑定在 ./useRig.ts。
 *
 * 引擎 init 前(pre-input-selection)的 verb 调用保持旧语义:引擎层容忍
 * (setChain/setAmp/setCab 只记 spec,rebuildGraph 空转;setInputGain 等有 ctx 守卫),
 * rigStore 不引入 ready 概念。
 */

import type { audioEngine } from '../audio/AudioEngine';
import type { ChainSpec, AmpSpec } from '../audio/AudioEngine';
import { getEffectDef } from '../audio/effects';
import { getAmpDef } from '../audio/amps';
import { getCabDef } from '../audio/cabs';
import {
  BUNDLED_WAVENET_MODELS,
  NAM_SWEEP_PACKS,
  setNamWasmModelSource,
  setNamWasmPack,
} from '../audio/namWasm';
import type { ShareState } from './share';
import {
  createChainItem,
  currentRigToPreset,
  presetToRig,
  exportPresetsJson,
  importPresetsJson,
  loadPresets,
  savePresets,
  loadSnapshots,
  saveSnapshots,
  type ChainItem,
  type Preset,
  type Snapshot,
} from './store';

/** rigStore 需要的引擎面(AudioEngine 的子集;测试用 stub 注入) */
export type RigEngine = Pick<
  typeof audioEngine,
  | 'setGlobalBypass'
  | 'setChain'
  | 'setAmp'
  | 'setCab'
  | 'updateParam'
  | 'updateAmpParam'
  | 'updateCabParam'
  | 'setInputGain'
  | 'setMasterVolume'
>;

/** Rig 全局参数(快照/分享不覆盖时,由当前值回填) */
export interface RigGlobals {
  inputGain: number;
  masterVolume: number;
  bypass: boolean;
}

export const RIG_GLOBAL_DEFAULTS: RigGlobals = {
  inputGain: 1,
  masterVolume: 0.5,
  bypass: false,
};

/** rigStore 持有的全部 Rig 状态(单一事实源) */
export interface RigStoreState {
  chain: ChainItem[];
  ampCategoryId: string;
  /** 每个箱头分类记住的型号(key = `${kind}:${ref}`,见 ampCategories.ts) */
  ampModelKeys: Record<string, string>;
  ampId: string;
  ampEnabled: boolean;
  ampValues: Record<string, number>;
  cabId: string;
  cabEnabled: boolean;
  cabValues: Record<string, number>;
  /** NAM 自定义模型名(模型源本身是 namWasm 模块级全局态,本次不收编) */
  namCustomName: string | null;
  /** NAM 模型版本:换模型 = 结构变化(引擎箱头实例复用 key 的一部分) */
  namVersion: number;
  inputGain: number;
  masterVolume: number;
  globalBypass: boolean;
  snapshots: (Snapshot | null)[];
  /** 激活快照槽;-1 = 无 */
  activeSlot: number;
  presets: Preset[];
  /** 图谱重建后自增,供依赖引擎侧节点引用(电平表/背景)的组件重读 */
  graphVersion: number;
}

/**
 * applyRig 的输入:三种恢复来源(预设/快照/分享)规范化后的统一形状。
 * chain 的 uid 由来源规范化时生成;ampModel 为 null 表示不经过型号机制
 * (快照路径:ampId 为权威,不触碰 NAM 全局态与 namVersion)。
 */
export interface ApplyRigState {
  chain: ChainItem[];
  ampModel: { categoryId: string; modelKey: string } | null;
  /** 仅快照路径(ampModel 为 null)需要提供;型号路径的 ampId 由 modelKey 推导 */
  ampId?: string;
  ampEnabled: boolean;
  ampValues: Record<string, number>;
  cabId: string;
  cabEnabled: boolean;
  cabValues: Record<string, number>;
  globals: RigGlobals;
}

export interface LoadPresetResult {
  ok: boolean;
  /** ok=false 时的用户可读原因(如缺少自定义 NAM 模型) */
  message?: string;
}

export interface RigStore {
  getState(): RigStoreState;
  subscribe(listener: () => void): () => void;

  // 链
  addPedal(effectId: string): void;
  removePedal(uid: string): void;
  movePedal(from: number, to: number): void;
  togglePedal(uid: string): void;
  /** 绝对设置开关(motion_midi 踩钉;值未变时不触发重建) */
  setPedalEnabled(uid: string, enabled: boolean): void;
  setPedalParam(uid: string, key: string, value: number): void;
  /** 翻转前置/后置(FX Loop);前置→后置落在 post 分区开头,后置→前置落在 pre 分区末尾 */
  setPedalPost(uid: string): void;

  // 箱头
  /** 直换箱头 def(参数回默认);型号层面的切换走 setAmpModel */
  setAmp(id: string): void;
  setAmpEnabled(enabled: boolean): void;
  setAmpParam(key: string, value: number): void;
  /** 切分类/选型号:记住该类型号并应用(NAM 型号自增 namVersion) */
  setAmpModel(categoryId: string, modelKey: string): void;
  /** 本地 .nam 文件加载成功后登记为当前类的自定义型号(不重置参数) */
  setNamCustomModel(displayName: string): void;

  // 箱体
  setCab(id: string): void;
  setCabEnabled(enabled: boolean): void;
  setCabParam(key: string, value: number): void;

  // 全局
  setInputGain(v: number): void;
  setMasterVolume(v: number): void;
  setGlobalBypass(bypass: boolean): void;

  /** 整 rig 恢复:预设/快照/分享三条路径的统一入口 */
  applyRig(rig: ApplyRigState): void;

  // 快照
  captureSnapshot(slot: number): void;
  recallSnapshot(slot: number): void;
  clearSnapshot(slot: number): void;
  /** dirty 是派生判定,不是存进去的状态 */
  isSlotDirty(slot: number): boolean;

  // 预设
  savePreset(name: string): void;
  loadPreset(name: string): LoadPresetResult;
  deletePreset(name: string): void;
  importPresets(json: string): number;
  exportPresets(): string;
}

function defaultChain(): ChainItem[] {
  return ['noiseGate', 'overdrive', 'volume', 'delay', 'reverb'].map((id) =>
    createChainItem(getEffectDef(id)),
  );
}

function defaultAmpValues(ampId: string): Record<string, number> {
  const values: Record<string, number> = {};
  for (const p of getAmpDef(ampId).params) values[p.key] = p.defaultValue;
  return values;
}

function defaultCabValues(cabId: string): Record<string, number> {
  const values: Record<string, number> = {};
  for (const p of getCabDef(cabId).params) values[p.key] = p.defaultValue;
  return values;
}

/** 解析型号 key(`${kind}:${ref}`,见 ampCategories.ts) */
function parseModelKey(modelKey: string): { kind: string; ref: string } {
  const sep = modelKey.indexOf(':');
  return { kind: modelKey.slice(0, sep), ref: modelKey.slice(sep + 1) };
}

/** 型号 key → 箱头 def id(builtin → ref,其余 → nam-wasm) */
function ampIdForModelKey(modelKey: string): string {
  const { kind, ref } = parseModelKey(modelKey);
  return kind === 'builtin' ? ref : 'nam-wasm';
}

/**
 * 应用一个箱头型号(与旧 App.applyAmpModel 语义一致):
 * 解析 ampId/默认参数;NAM 型号设置模块级模型源并要求 namVersion 换代。
 */
function resolveAmpModel(modelKey: string): {
  ampId: string;
  ampValues: Record<string, number>;
  namReload: boolean;
} {
  const { kind, ref } = parseModelKey(modelKey);
  if (kind === 'builtin') {
    return { ampId: ref, ampValues: defaultAmpValues(ref), namReload: false };
  }
  if (kind === 'nam-wasm-pack') {
    const pack = NAM_SWEEP_PACKS[ref];
    if (pack) setNamWasmPack(pack);
  } else {
    const m = BUNDLED_WAVENET_MODELS.find((x) => x.id === ref);
    if (m) setNamWasmModelSource(m.url);
  }
  return { ampId: 'nam-wasm', ampValues: defaultAmpValues('nam-wasm'), namReload: true };
}

/** 预设 → applyRig 输入(chain 重新生成 uid;箱头走型号机制) */
export function rigFromPreset(preset: Preset): ApplyRigState {
  const rig = presetToRig(preset);
  return {
    chain: rig.chain,
    ampModel: { categoryId: rig.amp.categoryId, modelKey: rig.amp.modelKey },
    ampEnabled: rig.amp.enabled,
    ampValues: rig.amp.values,
    cabId: rig.cab.id,
    cabEnabled: rig.cab.enabled,
    cabValues: rig.cab.values,
    globals: {
      inputGain: rig.globals.inputGain,
      masterVolume: rig.globals.masterVolume,
      bypass: rig.globals.bypass,
    },
  };
}

/** 快照 → applyRig 输入(快照不含型号与全局参数:型号机制绕过,全局由当前值回填) */
export function rigFromSnapshot(
  snap: Snapshot,
  globals: RigGlobals = RIG_GLOBAL_DEFAULTS,
): ApplyRigState {
  return {
    chain: snap.chain.map((item) => ({
      uid: crypto.randomUUID(),
      effectId: item.effectId,
      enabled: item.enabled,
      values: { ...item.values },
      post: item.post,
    })),
    ampModel: null,
    ampId: snap.ampId,
    ampEnabled: snap.ampEnabled,
    ampValues: { ...snap.ampValues },
    cabId: snap.cabId,
    cabEnabled: snap.cabEnabled,
    cabValues: { ...snap.cabValues },
    globals,
  };
}

/** 分享 → applyRig 输入(分享不含全局参数,由当前值回填) */
export function rigFromShare(
  share: ShareState,
  globals: RigGlobals = RIG_GLOBAL_DEFAULTS,
): ApplyRigState {
  return {
    chain: share.chain,
    ampModel: { categoryId: share.ampCategoryId, modelKey: share.ampModelKey },
    ampEnabled: share.ampEnabled,
    ampValues: share.ampValues,
    cabId: share.cabId,
    cabEnabled: share.cabEnabled,
    cabValues: share.cabValues,
    globals,
  };
}

/** 当前状态 → URL 分享编码的输入(分享只覆盖链条 + 箱头 + 箱体) */
export function rigToShareState(state: RigStoreState): ShareState {
  return {
    chain: state.chain,
    ampCategoryId: state.ampCategoryId,
    ampModelKey: state.ampModelKeys[state.ampCategoryId],
    ampEnabled: state.ampEnabled,
    ampValues: state.ampValues,
    cabId: state.cabId,
    cabEnabled: state.cabEnabled,
    cabValues: state.cabValues,
  };
}

/** 当前状态 → 快照对象(不含全局参数) */
function captureCurrentSnapshot(state: RigStoreState): Snapshot {
  return {
    chain: state.chain.map(({ effectId, enabled, values, post }) => ({
      effectId,
      enabled,
      values: { ...values },
      post,
    })),
    ampId: state.ampId,
    ampEnabled: state.ampEnabled,
    ampValues: { ...state.ampValues },
    cabId: state.cabId,
    cabEnabled: state.cabEnabled,
    cabValues: { ...state.cabValues },
  };
}

/** dirty 判定:当前状态与激活槽快照不一致(仅激活槽可 dirty) */
export function isSnapshotDirty(state: RigStoreState, slot: number): boolean {
  if (slot < 0 || slot !== state.activeSlot) return false;
  const snap = state.snapshots[slot];
  if (!snap) return false;
  return JSON.stringify(captureCurrentSnapshot(state)) !== JSON.stringify(snap);
}

export interface RigStoreInit {
  /** 初始 rig(出厂配置或 URL 分享还原),构造时经 applyRig 应用一次 */
  initialRig?: ApplyRigState | null;
}

export function createRigStore(engine: RigEngine, init?: RigStoreInit): RigStore {
  let state: RigStoreState = {
    chain: defaultChain(),
    ampCategoryId: 'crunch',
    ampModelKeys: {
      clean: 'builtin:clean',
      chime: 'builtin:chime',
      crunch: 'builtin:crunch',
      recto: 'builtin:recto',
    },
    ampId: 'crunch',
    ampEnabled: true,
    ampValues: defaultAmpValues('crunch'),
    cabId: 'gb4x12',
    cabEnabled: true,
    cabValues: defaultCabValues('gb4x12'),
    namCustomName: null,
    namVersion: 0,
    inputGain: RIG_GLOBAL_DEFAULTS.inputGain,
    masterVolume: RIG_GLOBAL_DEFAULTS.masterVolume,
    globalBypass: RIG_GLOBAL_DEFAULTS.bypass,
    snapshots: loadSnapshots(),
    activeSlot: -1,
    presets: loadPresets(),
    graphVersion: 0,
  };

  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };

  /** 结构同步:固定四连写引擎(每个 setter 内部 rebuildGraph,重建时回放 spec 携带的参数值)并自增 graphVersion */
  const syncStructure = () => {
    engine.setGlobalBypass(state.globalBypass);
    engine.setChain(
      state.chain.map(
        (item): ChainSpec => ({
          uid: item.uid,
          def: getEffectDef(item.effectId),
          enabled: item.enabled,
          values: item.values,
          post: item.post,
        }),
      ),
    );
    engine.setAmp({
      def: getAmpDef(state.ampId),
      enabled: state.ampEnabled,
      values: state.ampValues,
      // def+key 相同则重建复用箱头实例(避免 NAM 模型随单块变动重复加载)
      key: `${state.ampId}:${state.namVersion}`,
    } satisfies AmpSpec);
    engine.setCab({
      def: getCabDef(state.cabId),
      enabled: state.cabEnabled,
      values: state.cabValues,
    });
    state = { ...state, graphVersion: state.graphVersion + 1 };
  };

  const currentGlobals = (): RigGlobals => ({
    inputGain: state.inputGain,
    masterVolume: state.masterVolume,
    bypass: state.globalBypass,
  });

  const store: RigStore = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    // ---------- 链 ----------

    addPedal(effectId) {
      const item = createChainItem(getEffectDef(effectId));
      // 保持平铺数组前置在前、后置在后:前置类插入分区边界,后置类追加到尾
      const next = [...state.chain];
      if (item.post) {
        next.push(item);
      } else {
        const boundary = next.findIndex((i) => i.post);
        next.splice(boundary < 0 ? next.length : boundary, 0, item);
      }
      state = { ...state, chain: next };
      syncStructure();
      emit();
    },

    removePedal(uid) {
      state = { ...state, chain: state.chain.filter((i) => i.uid !== uid) };
      syncStructure();
      emit();
    },

    movePedal(from, to) {
      const next = [...state.chain];
      const [moved] = next.splice(from, 1);
      if (!moved) return;
      // 跨区拖动(目标位置属于另一分区)→ 同时翻转 post 归属
      const target = next[to] ?? next[to - 1];
      const moved2 =
        target && target.post !== moved.post ? { ...moved, post: target.post } : moved;
      next.splice(to, 0, moved2);
      state = { ...state, chain: next };
      syncStructure();
      emit();
    },

    togglePedal(uid) {
      state = {
        ...state,
        chain: state.chain.map((i) => (i.uid === uid ? { ...i, enabled: !i.enabled } : i)),
      };
      syncStructure();
      emit();
    },

    setPedalEnabled(uid, enabled) {
      const item = state.chain.find((i) => i.uid === uid);
      if (!item || item.enabled === enabled) return;
      store.togglePedal(uid);
    },

    setPedalParam(uid, key, value) {
      state = {
        ...state,
        chain: state.chain.map((i) =>
          i.uid === uid ? { ...i, values: { ...i.values, [key]: value } } : i,
        ),
      };
      engine.updateParam(uid, key, value);
      emit();
    },

    setPedalPost(uid) {
      const idx = state.chain.findIndex((i) => i.uid === uid);
      if (idx < 0) return;
      const item = { ...state.chain[idx], post: !state.chain[idx].post };
      const next = state.chain.filter((i) => i.uid !== uid);
      const boundary = next.findIndex((i) => i.post);
      next.splice(boundary < 0 ? next.length : boundary, 0, item);
      state = { ...state, chain: next };
      syncStructure();
      emit();
    },

    // ---------- 箱头 ----------

    setAmp(id) {
      state = { ...state, ampId: id, ampValues: defaultAmpValues(id) };
      syncStructure();
      emit();
    },

    setAmpEnabled(enabled) {
      state = { ...state, ampEnabled: enabled };
      syncStructure();
      emit();
    },

    setAmpParam(key, value) {
      state = { ...state, ampValues: { ...state.ampValues, [key]: value } };
      engine.updateAmpParam(key, value);
      emit();
    },

    setAmpModel(categoryId, modelKey) {
      const resolved = resolveAmpModel(modelKey);
      state = {
        ...state,
        ampCategoryId: categoryId,
        ampModelKeys: { ...state.ampModelKeys, [categoryId]: modelKey },
        ampId: resolved.ampId,
        ampValues: resolved.ampValues,
        namVersion: state.namVersion + (resolved.namReload ? 1 : 0),
      };
      syncStructure();
      emit();
    },

    setNamCustomModel(displayName) {
      state = {
        ...state,
        namCustomName: displayName,
        ampModelKeys: { ...state.ampModelKeys, [state.ampCategoryId]: 'nam-wasm:custom' },
        namVersion: state.namVersion + 1,
      };
      syncStructure();
      emit();
    },

    // ---------- 箱体 ----------

    setCab(id) {
      state = { ...state, cabId: id, cabValues: defaultCabValues(id) };
      syncStructure();
      emit();
    },

    setCabEnabled(enabled) {
      state = { ...state, cabEnabled: enabled };
      syncStructure();
      emit();
    },

    setCabParam(key, value) {
      state = { ...state, cabValues: { ...state.cabValues, [key]: value } };
      engine.updateCabParam(key, value);
      emit();
    },

    // ---------- 全局 ----------

    setInputGain(v) {
      state = { ...state, inputGain: v };
      engine.setInputGain(v);
      emit();
    },

    setMasterVolume(v) {
      state = { ...state, masterVolume: v };
      engine.setMasterVolume(v);
      emit();
    },

    setGlobalBypass(bypass) {
      state = { ...state, globalBypass: bypass };
      syncStructure();
      emit();
    },

    // ---------- 整 rig 恢复 ----------

    applyRig(rig) {
      let { namVersion } = state;
      if (rig.ampModel) {
        const resolved = resolveAmpModel(rig.ampModel.modelKey);
        if (resolved.namReload) namVersion += 1;
      }
      state = {
        ...state,
        chain: rig.chain,
        ampCategoryId: rig.ampModel?.categoryId ?? state.ampCategoryId,
        ampModelKeys: rig.ampModel
          ? { ...state.ampModelKeys, [rig.ampModel.categoryId]: rig.ampModel.modelKey }
          : state.ampModelKeys,
        ampId: rig.ampModel
          ? ampIdForModelKey(rig.ampModel.modelKey)
          : (rig.ampId ?? state.ampId),
        ampEnabled: rig.ampEnabled,
        ampValues: rig.ampValues,
        cabId: rig.cabId,
        cabEnabled: rig.cabEnabled,
        cabValues: rig.cabValues,
        inputGain: rig.globals.inputGain,
        masterVolume: rig.globals.masterVolume,
        globalBypass: rig.globals.bypass,
        namVersion,
      };
      syncStructure();
      engine.setInputGain(state.inputGain);
      engine.setMasterVolume(state.masterVolume);
      emit();
    },

    // ---------- 快照 ----------

    captureSnapshot(slot) {
      const snapshots = [...state.snapshots];
      snapshots[slot] = captureCurrentSnapshot(state);
      saveSnapshots(snapshots);
      state = { ...state, snapshots, activeSlot: slot };
      emit();
    },

    recallSnapshot(slot) {
      const snap = state.snapshots[slot];
      if (!snap) return;
      store.applyRig(rigFromSnapshot(snap, currentGlobals()));
      state = { ...state, activeSlot: slot };
      emit();
    },

    clearSnapshot(slot) {
      const snapshots = [...state.snapshots];
      snapshots[slot] = null;
      saveSnapshots(snapshots);
      state = {
        ...state,
        snapshots,
        activeSlot: state.activeSlot === slot ? -1 : state.activeSlot,
      };
      emit();
    },

    isSlotDirty(slot) {
      return isSnapshotDirty(state, slot);
    },

    // ---------- 预设 ----------

    savePreset(name) {
      const modelKey = state.ampModelKeys[state.ampCategoryId];
      const preset = currentRigToPreset(name, {
        chain: state.chain,
        amp: {
          categoryId: state.ampCategoryId,
          modelKey,
          enabled: state.ampEnabled,
          values: state.ampValues,
          customName: modelKey === 'nam-wasm:custom' ? state.namCustomName : null,
        },
        cab: {
          id: state.cabId,
          enabled: state.cabEnabled,
          values: state.cabValues,
        },
        globals: {
          inputGain: state.inputGain,
          masterVolume: state.masterVolume,
          bypass: state.globalBypass,
        },
      });
      const presets = [...state.presets.filter((p) => p.name !== name), preset];
      savePresets(presets);
      state = { ...state, presets };
      emit();
    },

    loadPreset(name) {
      const preset = state.presets.find((candidate) => candidate.name === name);
      if (!preset) return { ok: false };
      const rig = presetToRig(preset);
      if (
        rig.amp.modelKey === 'nam-wasm:custom' &&
        (!rig.amp.customName || rig.amp.customName !== state.namCustomName)
      ) {
        return {
          ok: false,
          message:
            `预设需要自定义 NAM 模型“${rig.amp.customName ?? '未知模型'}”。` +
            '请先在箱头区域重新载入对应的 .nam 文件。',
        };
      }
      store.applyRig(rigFromPreset(preset));
      return { ok: true };
    },

    deletePreset(name) {
      const presets = state.presets.filter((p) => p.name !== name);
      savePresets(presets);
      state = { ...state, presets };
      emit();
    },

    importPresets(json) {
      const imported = importPresetsJson(json);
      // 同名项以导入文件为准,其余本地预设保留。
      const merged = new Map(state.presets.map((preset) => [preset.name, preset]));
      for (const preset of imported) merged.set(preset.name, preset);
      const presets = [...merged.values()];
      savePresets(presets);
      state = { ...state, presets };
      emit();
      return imported.length;
    },

    exportPresets() {
      return exportPresetsJson(state.presets);
    },
  };

  // 初始 rig(出厂配置 / URL 分享还原):构造时应用一次,语义同旧的挂载 effect
  if (init?.initialRig) store.applyRig(init.initialRig);

  return store;
}
