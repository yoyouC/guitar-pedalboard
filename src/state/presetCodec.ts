import { TONE3000_KEY_PREFIX } from '../audio/namWasm';
export const RIG_PRESET_VERSION = 2;
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
  };
  cab: {
    id: string;
    enabled: boolean;
    values: Record<string, number>;
  };
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
  | { categoryId: string; modelKey: string }
  | { legacyAmpId: string };

/** 快照/恢复共用的箱头状态(引用 + 开关 + 参数) */
export type SnapshotAmp = SnapshotAmpRef & {
  enabled: boolean;
  values: Record<string, number>;
};

/** 快照/恢复共用的箱体状态 */
export interface SnapshotCab {
  id: string;
  enabled: boolean;
  values: Record<string, number>;
}

/** 快照:canonical Rig 表示减去 globals 的派生(ADR-0006) */
export interface Snapshot {
  chain: PresetChainItem[];
  amp: SnapshotAmp;
  cab: SnapshotCab;
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
    result.push({
      effectId: definition.id,
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
  if (!registered && requestedKey.startsWith(TONE3000_KEY_PREFIX)) {
    const namDef = catalog.amps.find((amp) => amp.id === 'nam-wasm');
    if (!namDef) return fallback;
    return {
      categoryId: 'tone3000',
      modelKey: requestedKey,
      enabled: typeof rawAmp.enabled === 'boolean' ? rawAmp.enabled : true,
      values: normalizeValues(namDef, rawAmp.values),
      customName: null,
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
  const requestedId = typeof source.id === 'string' ? source.id : fallback.id;
  const definition = catalog.cabs.find((cab) => cab.id === requestedId) ?? fallback;
  return {
    id: definition.id,
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

/** 用 catalog 规范化任意来源的 rig 输入(预设/分享/快照共用唯一的 normalize 实现) */
export function normalizeRig(rawRig: unknown, catalog: RigPresetCatalog): RigPresetState {
  const source = isRecord(rawRig) ? rawRig : {};
  return {
    chain: normalizeChain(source.chain, catalog),
    amp: normalizeAmp(source.amp, catalog),
    cab: normalizeCab(source.cab, catalog),
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
  if (isRecord(value.amp) && typeof value.amp.modelKey === 'string') {
    const amp = normalizeAmp({ ...value.amp, customName: null }, catalog);
    return {
      chain,
      amp: {
        categoryId: amp.categoryId,
        modelKey: amp.modelKey,
        enabled: amp.enabled,
        values: amp.values,
      },
      cab,
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
      globals: normalizeGlobals(undefined, catalog),
    },
  };
}

export function normalizeRigPreset(
  value: unknown,
  catalog: RigPresetCatalog,
): RigPreset | null {
  if (!isRecord(value)) return null;
  if (value.version !== RIG_PRESET_VERSION) return migrateLegacyPreset(value, catalog);
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
