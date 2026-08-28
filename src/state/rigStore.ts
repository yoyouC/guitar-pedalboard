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
import {
  getTone3000PedalDef,
  TONE3000_PEDAL_EFFECT_ID,
} from '../audio/effects/namPedal';
import { getAmpDef, getNamWasmAmpDef } from '../audio/amps';
import { getCabDef } from '../audio/cabs';
import { CAB_IR_RUNTIME_DEF } from '../audio/cabIrRuntime';
import {
  cabIdFromRef,
  defaultCabIrRef,
  isBuiltinCabId,
  type CabIrRef,
} from '../audio/cabIrTypes';
import {
  BUNDLED_WAVENET_MODELS,
  NAM_SWEEP_PACKS,
  buildTone3000Key,
  parseTone3000Key,
  type NamModelSelection,
} from '../audio/namWasm';
import type { ShareState } from './share';
import type { RigPreset, Snapshot, SnapshotAmp, SnapshotCab } from './presetCodec';
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
  RIG_PRESET_CATALOG,
  defaultAmpModelKeys,
  type ChainItem,
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

/** 默认值来自 catalog 单点(ADR-0006) */
export const RIG_GLOBAL_DEFAULTS: RigGlobals = {
  inputGain: RIG_PRESET_CATALOG.defaults.inputGain,
  masterVolume: RIG_PRESET_CATALOG.defaults.masterVolume,
  bypass: false,
};

/** 初始型号簿记来自 catalog 单点(store.ts 的 defaultAmpModelKeys) */

/** rigStore 持有的全部 Rig 状态(单一事实源) */
export interface RigStoreState {
  chain: ChainItem[];
  ampCategoryId: string;
  /** 每个箱头分类记住的型号(key = `${kind}:${ref}`,见 ampCategories.ts) */
  ampModelKeys: Record<string, string>;
  /** TONE3000 托管选择返回的精确箱头模型变体。 */
  ampTone3000ModelId: string | null;
  ampId: string;
  ampEnabled: boolean;
  ampValues: Record<string, number>;
  cabId: string;
  /** canonical、可序列化的 IR 身份；Blob/AudioBuffer 由 IR 服务持有。 */
  cabIrRef: CabIrRef;
  cabEnabled: boolean;
  cabValues: Record<string, number>;
  /** NAM 自定义模型名(展示用;模型选择本身在 namModel) */
  namCustomName: string | null;
  /** NAM 模型选择(ADR-0007):随状态传递,引擎侧不再读 namWasm 模块全局 */
  namModel: NamModelSelection;
  /** NAM 模型版本:换模型 = 结构变化(引擎箱头实例复用 key 的一部分) */
  namVersion: number;
  inputGain: number;
  masterVolume: number;
  globalBypass: boolean;
  snapshots: (Snapshot | null)[];
  /** 激活快照槽;-1 = 无 */
  activeSlot: number;
  presets: RigPreset[];
  /** 图谱重建后自增,供依赖引擎侧节点引用(电平表/背景)的组件重读 */
  graphVersion: number;
}

/**
 * applyRig 的输入:canonical Rig 表示 + uid 化 chain(ADR-0006)。
 * 三种恢复来源(预设/快照/分享)都规范化为这个形状;amp 是快照同款 union:
 * 型号机制分支(categoryId+modelKey)走型号机制,legacy 分支(legacyAmpId)
 * 保持旧快照行为——不触碰 NAM 全局态与 namVersion。
 */
export interface ApplyRigState {
  chain: ChainItem[];
  amp: SnapshotAmp;
  cab: SnapshotCab;
  globals: RigGlobals;
}

export interface LoadPresetResult {
  ok: boolean;
  /** ok=false 时的用户可读原因(如缺少自定义 NAM 模型) */
  message?: string;
}

export type RigRestoreHandler = (
  rig: ApplyRigState,
  commit: () => void,
) => Promise<LoadPresetResult>;

export interface RigStore {
  getState(): RigStoreState;
  subscribe(listener: () => void): () => void;

  // 链
  addPedal(effectId: string): void;
  /** 新增一个动态 TONE3000 NAM 单块，返回稳定 uid。 */
  addTone3000Pedal(modelRef: string, modelId?: string): string;
  /** 原位替换动态模型；目标不存在或类型不符时返回 false。 */
  replaceTone3000Pedal(uid: string, modelRef: string, modelId?: string): boolean;
  /** 外部模型重试成功后重建该运行实例；不改变 canonical Chain。 */
  reloadTone3000Pedal(uid: string): boolean;
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
  /** 纯视图切换分类(无记忆型号的分类,如未选模型的 tone3000):不改箱头、不触引擎 */
  setAmpCategory(categoryId: string): void;
  setAmpEnabled(enabled: boolean): void;
  setAmpParam(key: string, value: number): void;
  /** 切分类/选型号:记住该类型号并应用(NAM 型号自增 namVersion) */
  setAmpModel(categoryId: string, modelKey: string, modelId?: string): void;
  /** 已预取的外部模型恢复运行实例，不重置箱头参数。 */
  reloadTone3000Amp(modelRef: string, modelId?: string): boolean;
  /** 外部箱头恢复失败时仅降级运行实例，保留 canonical 引用与参数。 */
  demoteTone3000Amp(modelRef: string): boolean;
  /** 本地 .nam 文件加载成功后登记为当前类的自定义型号(不重置参数);sourceKey 为 namWasm 缓存键 */
  setNamCustomModel(displayName: string, sourceKey: string): void;

  // 箱体
  setCab(id: string): void;
  /** IR 服务完成 prepare/persist/activate 后的 canonical commit。 */
  commitCabIr(ref: CabIrRef): void;
  /** 注册整 Rig 恢复的异步 IR 准备事务；未注册时保持同步兼容行为。 */
  setRigRestoreHandler(handler: RigRestoreHandler): void;
  setCabEnabled(enabled: boolean): void;
  setCabParam(key: string, value: number): void;

  // 全局
  setInputGain(v: number): void;
  setMasterVolume(v: number): void;
  setGlobalBypass(bypass: boolean): void;

  /** 整 rig 恢复:预设/快照/分享三条路径的统一入口 */
  applyRig(rig: ApplyRigState): void;
  /** 外部恢复入口：先经过已注册的 IR prepare 事务，再调用 applyRig 提交。 */
  restoreRig(rig: ApplyRigState): Promise<LoadPresetResult>;

  // 快照
  captureSnapshot(slot: number): void;
  recallSnapshot(slot: number): Promise<LoadPresetResult>;
  clearSnapshot(slot: number): void;
  /** dirty 是派生判定,不是存进去的状态 */
  isSlotDirty(slot: number): boolean;

  // 预设
  savePreset(name: string): void;
  loadPreset(name: string): Promise<LoadPresetResult>;
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
  if (cabId === 'customIr') return { level: -2 };
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
 * 应用一个箱头型号(ADR-0007):
 * 解析 ampId/默认参数与模型选择(NamModelSelection);NAM 型号要求 namVersion 换代。
 * namModel 为 null 表示"不适用或保持当前选择"(builtin / nam-wasm:custom / 未知 ref)。
 */
function resolveAmpModel(modelKey: string, modelId?: string): {
  ampId: string;
  ampValues: Record<string, number>;
  namReload: boolean;
  namModel: NamModelSelection | null;
} {
  const { kind, ref } = parseModelKey(modelKey);
  if (kind === 'builtin') {
    return { ampId: ref, ampValues: defaultAmpValues(ref), namReload: false, namModel: null };
  }
  if (kind === 'tone3000') {
    // 外部模型引用(ADR-0007):装载经 namWasm 注册的 provider 按用户身份下载
    return {
      ampId: 'nam-wasm',
      ampValues: defaultAmpValues('nam-wasm'),
      namReload: true,
      namModel: { source: buildTone3000Key(ref), ...(modelId ? { modelId } : {}) },
    };
  }
  if (kind === 'nam-wasm-pack') {
    const pack = NAM_SWEEP_PACKS[ref];
    if (pack) {
      return {
        ampId: 'nam-wasm',
        ampValues: defaultAmpValues('nam-wasm'),
        namReload: true,
        namModel: { pack },
      };
    }
  } else {
    const m = BUNDLED_WAVENET_MODELS.find((x) => x.id === ref);
    if (m) {
      return {
        ampId: 'nam-wasm',
        ampValues: defaultAmpValues('nam-wasm'),
        namReload: true,
        namModel: { source: m.url },
      };
    }
  }
  // nam-wasm:custom 或未知 ref:保持当前选择(自定义模型的已知限制,见 ADR-0006)
  return { ampId: 'nam-wasm', ampValues: defaultAmpValues('nam-wasm'), namReload: true, namModel: null };
}

/** 预设 → applyRig 输入(chain 重新生成 uid;箱头走型号机制) */
export function rigFromPreset(preset: RigPreset): ApplyRigState {
  const rig = presetToRig(preset);
  return {
    chain: rig.chain,
    amp: {
      categoryId: rig.amp.categoryId,
      modelKey: rig.amp.modelKey,
      ...(rig.amp.modelId ? { modelId: rig.amp.modelId } : {}),
      enabled: rig.amp.enabled,
      values: rig.amp.values,
    },
    cab: rig.cab,
    globals: rig.globals,
  };
}

/** 快照 → applyRig 输入(薄派生:chain 补 uid;amp 分支原样透传;globals 由当前值回填) */
export function rigFromSnapshot(
  snap: Snapshot,
  globals: RigGlobals = RIG_GLOBAL_DEFAULTS,
): ApplyRigState {
  return {
    chain: snap.chain.map((item) => ({
      ...item,
      uid: crypto.randomUUID(),
      values: { ...item.values },
    })),
    amp: { ...snap.amp, values: { ...snap.amp.values } },
    cab: { ...snap.cab, values: { ...snap.cab.values } },
    globals,
  };
}

/** 分享 → applyRig 输入(薄派生:扁平字段收进 canonical 嵌套形状;globals 由当前值回填) */
export function rigFromShare(
  share: ShareState,
  globals: RigGlobals = RIG_GLOBAL_DEFAULTS,
): ApplyRigState {
  return {
    chain: share.chain,
    amp: {
      categoryId: share.ampCategoryId,
      modelKey: share.ampModelKey,
      ...(share.ampModelId ? { modelId: share.ampModelId } : {}),
      enabled: share.ampEnabled,
      values: share.ampValues,
    },
    cab: {
      id: share.cabId,
      ir: share.cabIrRef ?? (isBuiltinCabId(share.cabId)
        ? { kind: 'builtin', id: share.cabId }
        : defaultCabIrRef()),
      enabled: share.cabEnabled,
      values: share.cabValues,
    },
    globals,
  };
}

/** 当前状态 → URL 分享编码的输入(分享只覆盖链条 + 箱头 + 箱体) */
export function rigToShareState(state: RigStoreState): ShareState {
  return {
    chain: state.chain,
    ampCategoryId: state.ampCategoryId,
    ampModelKey: state.ampModelKeys[state.ampCategoryId],
    ...(state.ampTone3000ModelId ? { ampModelId: state.ampTone3000ModelId } : {}),
    ampEnabled: state.ampEnabled,
    ampValues: state.ampValues,
    cabId: state.cabId,
    cabIrRef: state.cabIrRef,
    cabEnabled: state.cabEnabled,
    cabValues: state.cabValues,
  };
}

/** 正向派生:当前状态 → 快照(= rig − globals;箱头记型号机制引用,见 ADR-0006) */
export function toSnapshot(state: RigStoreState): Snapshot {
  return {
    chain: state.chain.map(({ effectId, modelRef, modelId, enabled, values, post }) => ({
      effectId,
      ...(modelRef ? { modelRef } : {}),
      ...(modelId ? { modelId } : {}),
      enabled,
      values: { ...values },
      post,
    })),
    amp: {
      categoryId: state.ampCategoryId,
      modelKey: state.ampModelKeys[state.ampCategoryId],
      ...(state.ampTone3000ModelId ? { modelId: state.ampTone3000ModelId } : {}),
      enabled: state.ampEnabled,
      values: { ...state.ampValues },
    },
    cab: {
      id: state.cabId,
      ir: state.cabIrRef,
      enabled: state.cabEnabled,
      values: { ...state.cabValues },
    },
  };
}

/** dirty 判定:当前状态与激活槽快照不一致(仅激活槽可 dirty) */
export function isSnapshotDirty(state: RigStoreState, slot: number): boolean {
  if (slot < 0 || slot !== state.activeSlot) return false;
  const snap = state.snapshots[slot];
  if (!snap) return false;
  return JSON.stringify(toSnapshot(state)) !== JSON.stringify(snap);
}

/** IR Library 容量管理所需引用集合：当前 Rig、Preset、Snapshot 都视为 pinned。 */
export function referencedCustomIrHashes(state: RigStoreState): Set<string> {
  const hashes = new Set<string>();
  if (state.cabIrRef.kind === 'custom') hashes.add(state.cabIrRef.hash);
  for (const preset of state.presets) {
    if (preset.rig.cab.ir.kind === 'custom') hashes.add(preset.rig.cab.ir.hash);
  }
  for (const snapshot of state.snapshots) {
    if (snapshot?.cab.ir.kind === 'custom') hashes.add(snapshot.cab.ir.hash);
  }
  return hashes;
}

/** 删除提示所需的人类可读引用位置；不包含文件名或 hash。 */
export function customIrReferenceLabels(state: RigStoreState, hash: string): string[] {
  const labels: string[] = [];
  if (state.cabIrRef.kind === 'custom' && state.cabIrRef.hash === hash) labels.push('当前 Rig');
  for (const preset of state.presets) {
    if (preset.rig.cab.ir.kind === 'custom' && preset.rig.cab.ir.hash === hash) {
      labels.push(`预设“${preset.name}”`);
    }
  }
  state.snapshots.forEach((snapshot, index) => {
    if (snapshot?.cab.ir.kind === 'custom' && snapshot.cab.ir.hash === hash) {
      labels.push(`快照 ${String.fromCharCode(65 + index)}`);
    }
  });
  return labels;
}

export interface RigStoreInit {
  /** 初始 rig(出厂配置或 URL 分享还原),构造时经 applyRig 应用一次 */
  initialRig?: ApplyRigState | null;
}

export function createRigStore(engine: RigEngine, init?: RigStoreInit): RigStore {
  // 初始箱头/箱体来自 catalog 默认型号(ADR-0006 单点)
  const defaultModelKey = RIG_PRESET_CATALOG.defaults.ampModelKey;
  const defaultModel = RIG_PRESET_CATALOG.ampModels.find((m) => m.key === defaultModelKey);
  const initialAmpId = ampIdForModelKey(defaultModelKey);
  let state: RigStoreState = {
    chain: defaultChain(),
    ampCategoryId: defaultModel?.categoryId ?? RIG_PRESET_CATALOG.ampCategoryIds[0],
    ampModelKeys: defaultAmpModelKeys(),
    ampTone3000ModelId: null,
    ampId: initialAmpId,
    ampEnabled: true,
    ampValues: defaultAmpValues(initialAmpId),
    cabId: RIG_PRESET_CATALOG.defaults.cabId,
    cabIrRef: defaultCabIrRef(),
    cabEnabled: true,
    cabValues: defaultCabValues(RIG_PRESET_CATALOG.defaults.cabId),
    namCustomName: null,
    namModel: { source: BUNDLED_WAVENET_MODELS[0].url },
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
  const tone3000PedalGenerations = new Map<string, number>();
  let rigRestoreHandler: RigRestoreHandler | null = null;
  const emit = () => {
    for (const listener of listeners) listener();
  };

  // ---------- tone3000 非阻断降级(issue #14) ----------

  /**
   * 箱头回退目录默认(保留 ampCategoryId/ampModelKeys 与原引用——降级不写入
   * 持久化,重新登录后仍可恢复);检查完成前用户已切走则不降级。
   */
  const demoteUnavailableTone = (toneId: string) => {
    if (state.ampModelKeys[state.ampCategoryId] !== buildTone3000Key(toneId)) return;
    // 回退目录默认箱头(复用初始状态已解析的 initialAmpId);引用与参数保留
    state = { ...state, ampId: initialAmpId };
    syncStructure();
    emit();
  };

  const isTone3000Identity = (modelRef: string, modelId?: string) => {
    const toneId = parseTone3000Key(modelRef);
    return (
      toneId !== null &&
      /^\d+$/.test(toneId) &&
      (modelId === undefined || /^\d+$/.test(modelId))
    );
  };

  /** 结构同步:固定四连写引擎(每个 setter 内部 rebuildGraph,重建时回放 spec 携带的参数值)并自增 graphVersion */
  const syncStructure = () => {
    engine.setGlobalBypass(state.globalBypass);
    engine.setChain(
      state.chain.map(
        (item): ChainSpec => ({
          uid: item.uid,
          def:
            item.effectId === TONE3000_PEDAL_EFFECT_ID && item.modelRef
              ? getTone3000PedalDef(item.modelRef, item.modelId)
              : getEffectDef(item.effectId),
          key:
            item.effectId === TONE3000_PEDAL_EFFECT_ID && item.modelRef
              ? `${item.modelRef}${item.modelId ? `:model:${item.modelId}` : ''}:runtime:${tone3000PedalGenerations.get(item.uid) ?? 0}`
              : undefined,
          enabled: item.enabled,
          values: item.values,
          post: item.post,
        }),
      ),
    );
    engine.setAmp({
      // NAM 箱头:def 来自选择感知的 memoized 工厂(同一选择同一实例 → def+key 复用成立)
      def: state.ampId === 'nam-wasm' ? getNamWasmAmpDef(state.namModel) : getAmpDef(state.ampId),
      enabled: state.ampEnabled,
      values: state.ampValues,
      // def+key 相同则重建复用箱头实例(避免 NAM 模型随单块变动重复加载)
      key: `${state.ampId}:${state.namVersion}`,
    } satisfies AmpSpec);
    engine.setCab({
      def: CAB_IR_RUNTIME_DEF,
      enabled: state.cabEnabled,
      values: state.cabValues,
      key: 'cab-ir-runtime:v1',
      irRef: state.cabIrRef,
    });
    state = { ...state, graphVersion: state.graphVersion + 1 };
  };

  const currentGlobals = (): RigGlobals => ({
    inputGain: state.inputGain,
    masterVolume: state.masterVolume,
    bypass: state.globalBypass,
  });

  const runRestoreTransaction = (
    rig: ApplyRigState,
    commit: () => void,
  ): Promise<LoadPresetResult> => {
    if (rigRestoreHandler) return rigRestoreHandler(rig, commit);
    commit();
    return Promise.resolve({ ok: true });
  };

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

    addTone3000Pedal(modelRef, modelId) {
      if (!isTone3000Identity(modelRef, modelId)) {
        throw new RangeError('TONE3000 tone/model id 格式无效');
      }
      const item = createChainItem(getEffectDef(TONE3000_PEDAL_EFFECT_ID));
      const dynamicItem: ChainItem = { ...item, modelRef, ...(modelId ? { modelId } : {}) };
      const next = [...state.chain];
      const boundary = next.findIndex((candidate) => candidate.post);
      next.splice(boundary < 0 ? next.length : boundary, 0, dynamicItem);
      state = { ...state, chain: next };
      syncStructure();
      emit();
      return dynamicItem.uid;
    },

    replaceTone3000Pedal(uid, modelRef, modelId) {
      if (!isTone3000Identity(modelRef, modelId)) return false;
      const target = state.chain.find(
        (item) => item.uid === uid && item.effectId === TONE3000_PEDAL_EFFECT_ID,
      );
      if (!target) return false;
      state = {
        ...state,
        chain: state.chain.map((item) =>
          item.uid === uid
            ? { ...item, modelRef, modelId: modelId || undefined }
            : item,
        ),
      };
      syncStructure();
      emit();
      return true;
    },

    reloadTone3000Pedal(uid) {
      const target = state.chain.find(
        (item) => item.uid === uid && item.effectId === TONE3000_PEDAL_EFFECT_ID,
      );
      if (!target) return false;
      tone3000PedalGenerations.set(uid, (tone3000PedalGenerations.get(uid) ?? 0) + 1);
      syncStructure();
      emit();
      return true;
    },

    removePedal(uid) {
      tone3000PedalGenerations.delete(uid);
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

    setAmpCategory(categoryId) {
      state = { ...state, ampCategoryId: categoryId };
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

    setAmpModel(categoryId, modelKey, modelId) {
      const tone3000Model = modelKey.startsWith('tone3000:');
      if (
        (tone3000Model && categoryId !== 'tone3000') ||
        (categoryId === 'tone3000' && !isTone3000Identity(modelKey, modelId))
      ) return;
      const resolved = resolveAmpModel(modelKey, modelId);
      state = {
        ...state,
        ampCategoryId: categoryId,
        ampModelKeys: { ...state.ampModelKeys, [categoryId]: modelKey },
        ampTone3000ModelId: modelKey.startsWith('tone3000:') ? modelId ?? null : null,
        ampId: resolved.ampId,
        ampValues: resolved.ampValues,
        namModel: resolved.namModel ?? state.namModel,
        namVersion: state.namVersion + (resolved.namReload ? 1 : 0),
      };
      syncStructure();
      emit();
    },

    reloadTone3000Amp(modelRef, modelId) {
      if (
        !isTone3000Identity(modelRef, modelId) ||
        state.ampCategoryId !== 'tone3000' ||
        state.ampModelKeys.tone3000 !== modelRef
      ) {
        return false;
      }
      state = {
        ...state,
        ampId: 'nam-wasm',
        ampTone3000ModelId: modelId ?? null,
        namModel: { source: modelRef, ...(modelId ? { modelId } : {}) },
        namVersion: state.namVersion + 1,
      };
      syncStructure();
      emit();
      return true;
    },

    demoteTone3000Amp(modelRef) {
      const toneId = parseTone3000Key(modelRef);
      if (!isTone3000Identity(modelRef) || toneId === null) return false;
      if (state.ampCategoryId !== 'tone3000' || state.ampModelKeys.tone3000 !== modelRef) {
        return false;
      }
      demoteUnavailableTone(toneId);
      return true;
    },

    setNamCustomModel(displayName, sourceKey) {
      state = {
        ...state,
        namCustomName: displayName,
        namModel: { source: sourceKey },
        ampModelKeys: { ...state.ampModelKeys, [state.ampCategoryId]: 'nam-wasm:custom' },
        namVersion: state.namVersion + 1,
      };
      syncStructure();
      emit();
    },

    // ---------- 箱体 ----------

    setCab(id) {
      if (!isBuiltinCabId(id)) return;
      const ref: CabIrRef = { kind: 'builtin', id };
      state = { ...state, cabId: id, cabIrRef: ref, cabValues: defaultCabValues(id) };
      syncStructure();
      for (const [key, value] of Object.entries(state.cabValues)) engine.updateCabParam(key, value);
      emit();
    },

    commitCabIr(ref) {
      const cabId = cabIdFromRef(ref);
      state = {
        ...state,
        cabId,
        cabIrRef: ref,
        cabValues: cabId === state.cabId ? state.cabValues : defaultCabValues(cabId),
      };
      syncStructure();
      for (const [key, value] of Object.entries(state.cabValues)) engine.updateCabParam(key, value);
      emit();
    },

    setRigRestoreHandler(handler) {
      rigRestoreHandler = handler;
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
      // 型号机制分支:解析模型源并换代;legacy 分支(旧快照):不动型号簿记与模型选择
      const ampRef = rig.amp;
      let ampId: string;
      let namModel = state.namModel;
      let { ampCategoryId, ampModelKeys } = state;
      let ampTone3000ModelId = state.ampTone3000ModelId;
      if ('modelKey' in ampRef) {
        const resolved = resolveAmpModel(ampRef.modelKey, ampRef.modelId);
        if (resolved.namReload) namVersion += 1;
        ampId = ampIdForModelKey(ampRef.modelKey);
        ampCategoryId = ampRef.categoryId;
        ampModelKeys = { ...state.ampModelKeys, [ampRef.categoryId]: ampRef.modelKey };
        ampTone3000ModelId = ampRef.modelKey.startsWith('tone3000:')
          ? ampRef.modelId ?? null
          : null;
        namModel = resolved.namModel ?? state.namModel;
      } else {
        ampId = ampRef.legacyAmpId;
      }
      state = {
        ...state,
        chain: rig.chain,
        ampCategoryId,
        ampModelKeys,
        ampTone3000ModelId,
        ampId,
        namModel,
        ampEnabled: rig.amp.enabled,
        ampValues: rig.amp.values,
        cabId: rig.cab.id,
        cabIrRef: rig.cab.ir,
        cabEnabled: rig.cab.enabled,
        cabValues: rig.cab.values,
        inputGain: rig.globals.inputGain,
        masterVolume: rig.globals.masterVolume,
        globalBypass: rig.globals.bypass,
        namVersion,
      };
      syncStructure();
      for (const [key, value] of Object.entries(state.cabValues)) engine.updateCabParam(key, value);
      engine.setInputGain(state.inputGain);
      engine.setMasterVolume(state.masterVolume);
      emit();
    },

    restoreRig(rig) {
      return runRestoreTransaction(rig, () => store.applyRig(rig));
    },

    // ---------- 快照 ----------

    captureSnapshot(slot) {
      const snapshots = [...state.snapshots];
      snapshots[slot] = toSnapshot(state);
      saveSnapshots(snapshots);
      state = { ...state, snapshots, activeSlot: slot };
      emit();
    },

    recallSnapshot(slot) {
      const snap = state.snapshots[slot];
      if (!snap) return Promise.resolve({ ok: false });
      const rig = rigFromSnapshot(snap, currentGlobals());
      return runRestoreTransaction(rig, () => {
        store.applyRig(rig);
        state = { ...state, activeSlot: slot };
        emit();
      });
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
          ...(state.ampTone3000ModelId ? { modelId: state.ampTone3000ModelId } : {}),
        },
        cab: {
          id: state.cabId,
          ir: state.cabIrRef,
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
      if (!preset) return Promise.resolve({ ok: false });
      const rig = presetToRig(preset);
      if (
        rig.amp.modelKey === 'nam-wasm:custom' &&
        (!rig.amp.customName || rig.amp.customName !== state.namCustomName)
      ) {
        return Promise.resolve({
          ok: false,
          message:
            `预设需要自定义 NAM 模型“${rig.amp.customName ?? '未知模型'}”。` +
            '请先在箱头区域重新载入对应的 .nam 文件。',
        });
      }
      const nextRig = rigFromPreset(preset);
      return store.restoreRig(nextRig);
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
