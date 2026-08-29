import type { CabIrRef } from '../audio/cabIrTypes';
import { isBuiltinCabId } from '../audio/cabIrTypes';
import {
  PRE_AMP_EQ_BANDS,
  createDefaultPreAmpEqState,
  normalizePreAmpEqDb,
  type PreAmpEqState,
} from '../audio/preAmpEq';

export const RIG_PRESET_VERSION = 5;
export const PRESET_EXPORT_FORMAT = 'guitar-pedalboard-presets';
export const PRESET_EXPORT_VERSION = 1;

export interface PresetParamDefinition {
  key: string;
  min: number;
  max: number;
  defaultValue: number;
}

export interface PresetModuleDefinition {
  id: string;
  params: PresetParamDefinition[];
}

export interface PresetEffectDefinition extends PresetModuleDefinition {
  defaultPost: boolean;
}

export interface PresetAmpModelDefinition {
  key: string;
  categoryId: string;
  ampId: string;
}

export interface RigPresetCatalog {
  effects: PresetEffectDefinition[];
  amps: PresetModuleDefinition[];
  cabs: PresetModuleDefinition[];
  ampModels: PresetAmpModelDefinition[];
  ampCategoryIds: string[];
  defaults: {
    ampModelKey: string;
    cabId: string;
    inputGain: number;
    masterVolume: number;
  };
}

export interface PresetChainItem {
  effectId: string;
  /** 动态模型引用；首个实现为 `tone3000:{toneId}`。 */
  modelRef?: string;
  /** 托管 Select 返回的精确模型变体；缺省时按 tone 选择默认兼容模型。 */
  modelId?: string;
  enabled: boolean;
  values: Record<string, number>;
  post: boolean;
}

export interface RigPresetState {
  chain: PresetChainItem[];
  amp: {
    categoryId: string;
    modelKey: string;
    enabled: boolean;
    values: Record<string, number>;
    customName: string | null;
    /** TONE3000 Select/load_tone 返回的精确模型变体。 */
    modelId?: string;
  };
  cab: {
    id: string;
    ir: CabIrRef;
    enabled: boolean;
    values: Record<string, number>;
  };
  preAmpEq: PreAmpEqState;
  globals: {
    inputGain: number;
    masterVolume: number;
    bypass: boolean;
  };
}

export interface RigPreset {
  version: typeof RIG_PRESET_VERSION;
  name: string;
  rig: RigPresetState;
}

export interface RestoredRigPresetState extends Omit<RigPresetState, 'chain'> {
  chain: Array<PresetChainItem & { uid: string }>;
}

/**
 * 快照的箱头引用(ADR-0006):
 * - 型号机制分支:categoryId + modelKey,recall 走型号机制(2026-08 起的新形状);
 * - legacy 分支:旧持久化数据只有扁平 ampId,recall 保持旧行为(绕过型号机制)。
 */
export type SnapshotAmpRef =
  | { categoryId: string; modelKey: string; modelId?: string }
  | { legacyAmpId: string };

/** 快照/恢复共用的箱头状态(引用 + 开关 + 参数) */
export type SnapshotAmp = SnapshotAmpRef & {
  enabled: boolean;
  values: Record<string, number>;
};

/** 快照/恢复共用的箱体状态 */
export interface SnapshotCab {
  id: string;
  ir: CabIrRef;
  enabled: boolean;
  values: Record<string, number>;
}

/** 快照:canonical Rig 表示减去 globals 的派生(ADR-0006) */
export interface Snapshot {
  chain: PresetChainItem[];
  amp: SnapshotAmp;
  cab: SnapshotCab;
  preAmpEq: PreAmpEqState;
}

interface PresetExportEnvelope {
  format: typeof PRESET_EXPORT_FORMAT;
  version: typeof PRESET_EXPORT_VERSION;
  exportedAt: string;
  presets: RigPreset[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isFiniteNumberRecord(value: unknown): value is Record<string, number> {
  return isRecord(value)
    && Object.values(value).every((item) => typeof item === 'number' && Number.isFinite(item));
}

function isCurrentPreAmpEqBands(value: unknown): boolean {
  if (!isFiniteNumberRecord(value)) return false;
  const keys = PRE_AMP_EQ_BANDS.map((band) => band.key);
  return hasOnlyKeys(value, keys) && keys.every((key) => key in value);
}

function isCabIrShape(value: unknown, cabId: string): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === 'builtin') {
    return hasOnlyKeys(value, ['kind', 'id'])
      && typeof value.id === 'string'
      && value.id === cabId;
  }
  return value.kind === 'custom'
    && hasOnlyKeys(value, ['kind', 'hash'])
    && typeof value.hash === 'string'
    && /^[a-f\d]{64}$/i.test(value.hash)
    && cabId === 'customIr';
}

/**
 * Strictly decodes the current canonical Rig shape without consulting the live
 * equipment catalog. Historical revisions can therefore retain removed gear,
 * while schema ownership remains beside RigPresetState and normalizeRig.
 */
export function decodeCurrentRigPresetState(value: unknown): RigPresetState | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['chain', 'amp', 'cab', 'preAmpEq', 'globals'])) {
    return null;
  }
  if (!Array.isArray(value.chain) || !value.chain.every((item) => (
    isRecord(item)
    && hasOnlyKeys(item, ['effectId', 'modelRef', 'modelId', 'enabled', 'values', 'post'])
    && typeof item.effectId === 'string'
    && item.effectId.length > 0
    && (item.modelRef === undefined
      || (typeof item.modelRef === 'string' && /^tone3000:\d+$/.test(item.modelRef)))
    && (item.modelId === undefined
      || (typeof item.modelId === 'string' && /^\d+$/.test(item.modelId)))
    && typeof item.enabled === 'boolean'
    && isFiniteNumberRecord(item.values)
    && typeof item.post === 'boolean'
  ))) return null;

  const amp = value.amp;
  const cab = value.cab;
  const preAmpEq = value.preAmpEq;
  const globals = value.globals;
  if (!(isRecord(amp)
    && hasOnlyKeys(amp, ['categoryId', 'modelKey', 'modelId', 'enabled', 'values', 'customName'])
    && typeof amp.categoryId === 'string'
    && amp.categoryId.length > 0
    && typeof amp.modelKey === 'string'
    && amp.modelKey.length > 0
    && (amp.modelId === undefined || (typeof amp.modelId === 'string' && /^\d+$/.test(amp.modelId)))
    && typeof amp.enabled === 'boolean'
    && isFiniteNumberRecord(amp.values)
    && (amp.customName === null || typeof amp.customName === 'string')
    && isRecord(cab)
    && hasOnlyKeys(cab, ['id', 'ir', 'enabled', 'values'])
    && typeof cab.id === 'string'
    && cab.id.length > 0
    && isCabIrShape(cab.ir, cab.id)
    && typeof cab.enabled === 'boolean'
    && isFiniteNumberRecord(cab.values)
    && isRecord(preAmpEq)
    && hasOnlyKeys(preAmpEq, ['enabled', 'bands', 'levelDb'])
    && typeof preAmpEq.enabled === 'boolean'
    && isCurrentPreAmpEqBands(preAmpEq.bands)
    && typeof preAmpEq.levelDb === 'number'
    && Number.isFinite(preAmpEq.levelDb)
    && isRecord(globals)
    && hasOnlyKeys(globals, ['inputGain', 'masterVolume', 'bypass'])
    && typeof globals.inputGain === 'number'
    && Number.isFinite(globals.inputGain)
    && typeof globals.masterVolume === 'number'
    && Number.isFinite(globals.masterVolume)
    && typeof globals.bypass === 'boolean')) return null;

  return value as unknown as RigPresetState;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return Math.min(max, Math.max(min, finiteNumber(value, fallback)));
}

function normalizeValues(
  definition: PresetModuleDefinition,
  rawValues: unknown,
): Record<string, number> {
  const source = isRecord(rawValues) ? rawValues : {};
  const values: Record<string, number> = {};
  for (const param of definition.params) {
    values[param.key] = clamp(
      source[param.key],
      param.min,
      param.max,
      param.defaultValue,
    );
  }
  return values;
}

function normalizeChain(rawItems: unknown, catalog: RigPresetCatalog): PresetChainItem[] {
  if (!Array.isArray(rawItems)) return [];
  const result: PresetChainItem[] = [];
  for (const rawItem of rawItems) {
    if (!isRecord(rawItem) || typeof rawItem.effectId !== 'string') continue;
    const definition = catalog.effects.find((effect) => effect.id === rawItem.effectId);
    if (!definition) continue;
    const isTone3000Pedal = definition.id === 'tone3000Nam';
    const modelRef =
      isTone3000Pedal && typeof rawItem.modelRef === 'string' && /^tone3000:\d+$/.test(rawItem.modelRef)
        ? rawItem.modelRef
        : undefined;
    if (isTone3000Pedal && !modelRef) continue;
    const modelId =
      modelRef && typeof rawItem.modelId === 'string' && /^\d+$/.test(rawItem.modelId)
        ? rawItem.modelId
        : undefined;
    result.push({
      effectId: definition.id,
      ...(modelRef ? { modelRef } : {}),
      ...(modelId ? { modelId } : {}),
      enabled: typeof rawItem.enabled === 'boolean' ? rawItem.enabled : true,
      values: normalizeValues(definition, rawItem.values),
      post: typeof rawItem.post === 'boolean' ? rawItem.post : definition.defaultPost,
    });
  }
  return result;
}

function defaultAmp(catalog: RigPresetCatalog): RigPresetState['amp'] {
  const model = catalog.ampModels.find(
    (candidate) => candidate.key === catalog.defaults.ampModelKey,
  );
  if (!model) throw new Error('预设目录缺少默认箱头型号');
  const definition = catalog.amps.find((amp) => amp.id === model.ampId);
  if (!definition) throw new Error('预设目录缺少默认箱头定义');
  return {
    categoryId: model.categoryId,
    modelKey: model.key,
    enabled: true,
    values: normalizeValues(definition, {}),
    customName: null,
  };
}

function normalizeAmp(rawAmp: unknown, catalog: RigPresetCatalog): RigPresetState['amp'] {
  const fallback = defaultAmp(catalog);
  if (!isRecord(rawAmp)) return fallback;
  const requestedKey =
    typeof rawAmp.modelKey === 'string' ? rawAmp.modelKey : fallback.modelKey;
  const registered = catalog.ampModels.find((model) => model.key === requestedKey);
  // tone3000: 外部模型引用(ADR-0007)——按 kind 前缀放行,不查静态表;
  // categoryId 固定 'tone3000',参数按 nam-wasm def 钳制
  if (!registered && /^tone3000:\d+$/.test(requestedKey)) {
    const namDef = catalog.amps.find((amp) => amp.id === 'nam-wasm');
    if (!namDef) return fallback;
    return {
      categoryId: 'tone3000',
      modelKey: requestedKey,
      enabled: typeof rawAmp.enabled === 'boolean' ? rawAmp.enabled : true,
      values: normalizeValues(namDef, rawAmp.values),
      customName: null,
      ...(typeof rawAmp.modelId === 'string' && /^\d+$/.test(rawAmp.modelId)
        ? { modelId: rawAmp.modelId }
        : {}),
    };
  }
  const custom = requestedKey === 'nam-wasm:custom';
  const ampId = registered?.ampId ?? (custom ? 'nam-wasm' : null);
  const definition = catalog.amps.find((amp) => amp.id === ampId);
  if (!definition) return fallback;
  const requestedCategory =
    typeof rawAmp.categoryId === 'string' ? rawAmp.categoryId : '';
  const categoryId = registered?.categoryId ??
    (custom && catalog.ampCategoryIds.includes(requestedCategory)
      ? requestedCategory
      : fallback.categoryId);
  return {
    categoryId,
    modelKey: registered?.key ?? 'nam-wasm:custom',
    enabled: typeof rawAmp.enabled === 'boolean' ? rawAmp.enabled : true,
    values: normalizeValues(definition, rawAmp.values),
    customName:
      custom && typeof rawAmp.customName === 'string' && rawAmp.customName.trim()
        ? rawAmp.customName.trim()
        : null,
  };
}

function normalizeCab(rawCab: unknown, catalog: RigPresetCatalog): RigPresetState['cab'] {
  const fallback = catalog.cabs.find((cab) => cab.id === catalog.defaults.cabId);
  if (!fallback) throw new Error('预设目录缺少默认箱体定义');
  const source = isRecord(rawCab) ? rawCab : {};
  const rawIr = isRecord(source.ir) ? source.ir : null;
  const customHash =
    rawIr?.kind === 'custom' &&
    typeof rawIr.hash === 'string' &&
    /^[a-f\d]{64}$/i.test(rawIr.hash)
      ? rawIr.hash.toLowerCase()
      : null;
  const customDefinition = catalog.cabs.find((cab) => cab.id === 'customIr');
  if (customHash && customDefinition) {
    return {
      id: 'customIr',
      ir: { kind: 'custom', hash: customHash },
      enabled: typeof source.enabled === 'boolean' ? source.enabled : true,
      values: normalizeValues(customDefinition, source.values),
    };
  }
  const irBuiltinId = rawIr?.kind === 'builtin' && isBuiltinCabId(rawIr.id) ? rawIr.id : null;
  const requestedId = irBuiltinId ?? (typeof source.id === 'string' ? source.id : fallback.id);
  const definition = catalog.cabs.find((cab) => cab.id === requestedId && cab.id !== 'customIr') ?? fallback;
  const builtinId = isBuiltinCabId(definition.id)
    ? definition.id
    : (isBuiltinCabId(fallback.id) ? fallback.id : 'gb4x12');
  return {
    id: definition.id,
    ir: { kind: 'builtin', id: builtinId },
    enabled: typeof source.enabled === 'boolean' ? source.enabled : true,
    values: normalizeValues(definition, source.values),
  };
}

function normalizeGlobals(
  rawGlobals: unknown,
  catalog: RigPresetCatalog,
): RigPresetState['globals'] {
  const source = isRecord(rawGlobals) ? rawGlobals : {};
  return {
    inputGain: clamp(source.inputGain, 0, 2, catalog.defaults.inputGain),
    masterVolume: clamp(source.masterVolume, 0, 1, catalog.defaults.masterVolume),
    bypass: typeof source.bypass === 'boolean' ? source.bypass : false,
  };
}

function normalizePreAmpEq(rawEq: unknown): PreAmpEqState {
  const fallback = createDefaultPreAmpEqState();
  const source = isRecord(rawEq) ? rawEq : {};
  const rawBands = isRecord(source.bands) ? source.bands : {};
  for (const band of PRE_AMP_EQ_BANDS) {
    fallback.bands[band.key] = normalizePreAmpEqDb(rawBands[band.key]);
  }
  fallback.enabled = typeof source.enabled === 'boolean' ? source.enabled : false;
  fallback.levelDb = normalizePreAmpEqDb(source.levelDb);
  return fallback;
}

/** 用 catalog 规范化任意来源的 rig 输入(预设/分享/快照共用唯一的 normalize 实现) */
export function normalizeRig(rawRig: unknown, catalog: RigPresetCatalog): RigPresetState {
  const source = isRecord(rawRig) ? rawRig : {};
  return {
    chain: normalizeChain(source.chain, catalog),
    amp: normalizeAmp(source.amp, catalog),
    cab: normalizeCab(source.cab, catalog),
    preAmpEq: normalizePreAmpEq(source.preAmpEq),
    globals: normalizeGlobals(source.globals, catalog),
  };
}

/**
 * 宽容解析任意来源的快照数据(ADR-0006):
 * - 新形状(amp 为 record 且带 modelKey)→ 经 catalog normalize 的型号机制分支;
 *   未知型号回退目录默认箱头(槽位存活);
 * - 旧形状(扁平 ampId)→ legacy 分支;未知 ampId 视为坏槽位(返回 null,
 *   旧行为是裸奔进 getAmpDef throw);
 * - 其余(非对象、缺链、无箱头引用)→ null,由加载方置空槽位。
 */
export function normalizeSnapshot(value: unknown, catalog: RigPresetCatalog): Snapshot | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.chain)) return null;
  const chain = normalizeChain(value.chain, catalog);
  const cab = normalizeCab(
    isRecord(value.cab)
      ? value.cab
      : { id: value.cabId, enabled: value.cabEnabled, values: value.cabValues },
    catalog,
  );
  const preAmpEq = normalizePreAmpEq(value.preAmpEq);
  if (isRecord(value.amp) && typeof value.amp.modelKey === 'string') {
    const amp = normalizeAmp({ ...value.amp, customName: null }, catalog);
    return {
      chain,
      amp: {
        categoryId: amp.categoryId,
        modelKey: amp.modelKey,
        ...(amp.modelId ? { modelId: amp.modelId } : {}),
        enabled: amp.enabled,
        values: amp.values,
      },
      cab,
      preAmpEq,
    };
  }
  if (typeof value.ampId === 'string') {
    const definition = catalog.amps.find((amp) => amp.id === value.ampId);
    if (!definition) return null;
    return {
      chain,
      amp: {
        legacyAmpId: definition.id,
        enabled: typeof value.ampEnabled === 'boolean' ? value.ampEnabled : true,
        values: normalizeValues(definition, value.ampValues),
      },
      cab,
      preAmpEq,
    };
  }
  return null;
}

function migrateLegacyPreset(
  source: Record<string, unknown>,
  catalog: RigPresetCatalog,
): RigPreset | null {
  if (typeof source.name !== 'string' || !source.name.trim() || !Array.isArray(source.items)) {
    return null;
  }
  return {
    version: RIG_PRESET_VERSION,
    name: source.name.trim(),
    rig: {
      chain: normalizeChain(source.items, catalog),
      amp: defaultAmp(catalog),
      cab: normalizeCab(undefined, catalog),
      preAmpEq: normalizePreAmpEq(undefined),
      globals: normalizeGlobals(undefined, catalog),
    },
  };
}

/** v2-v4 已是 canonical Rig；经当前 normalize 补齐后续身份字段。 */
function migratePreviousPreset(
  source: Record<string, unknown>,
  catalog: RigPresetCatalog,
): RigPreset | null {
  if (
    (source.version !== 2 && source.version !== 3 && source.version !== 4) ||
    typeof source.name !== 'string' ||
    !source.name.trim() ||
    !isRecord(source.rig)
  ) {
    return null;
  }
  return {
    version: RIG_PRESET_VERSION,
    name: source.name.trim(),
    rig: normalizeRig(source.rig, catalog),
  };
}

export function normalizeRigPreset(
  value: unknown,
  catalog: RigPresetCatalog,
): RigPreset | null {
  if (!isRecord(value)) return null;
  if (value.version !== RIG_PRESET_VERSION) {
    return migratePreviousPreset(value, catalog) ?? migrateLegacyPreset(value, catalog);
  }
  if (typeof value.name !== 'string' || !value.name.trim() || !isRecord(value.rig)) {
    return null;
  }
  return {
    version: RIG_PRESET_VERSION,
    name: value.name.trim(),
    rig: normalizeRig(value.rig, catalog),
  };
}

export function createRigPreset(
  name: string,
  rig: RigPresetState,
  catalog: RigPresetCatalog,
): RigPreset {
  const preset = normalizeRigPreset(
    { version: RIG_PRESET_VERSION, name, rig },
    catalog,
  );
  if (!preset) throw new Error('预设名称不能为空');
  return preset;
}

export function restoreRigPreset(
  preset: RigPreset,
  catalog: RigPresetCatalog,
  createUid: () => string = () => crypto.randomUUID(),
): RestoredRigPresetState {
  const normalized = normalizeRigPreset(preset, catalog);
  if (!normalized) throw new Error('预设格式无效');
  return {
    ...normalized.rig,
    chain: normalized.rig.chain.map((item) => ({ ...item, uid: createUid() })),
  };
}

export function exportRigPresetsJson(presets: RigPreset[]): string {
  const envelope: PresetExportEnvelope = {
    format: PRESET_EXPORT_FORMAT,
    version: PRESET_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    presets,
  };
  return JSON.stringify(envelope, null, 2);
}

export function importRigPresetsJson(
  text: string,
  catalog: RigPresetCatalog,
): RigPreset[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('文件不是有效的 JSON');
  }
  const candidates =
    Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) &&
          parsed.format === PRESET_EXPORT_FORMAT &&
          parsed.version === PRESET_EXPORT_VERSION &&
          Array.isArray(parsed.presets)
        ? parsed.presets
        : null;
  if (!candidates) throw new Error('不支持的预设文件格式');
  const presets = candidates
    .map((candidate) => normalizeRigPreset(candidate, catalog))
    .filter((preset): preset is RigPreset => preset !== null);
  if (candidates.length > 0 && presets.length === 0) {
    throw new Error('文件中没有可用的预设');
  }
  return presets;
}
