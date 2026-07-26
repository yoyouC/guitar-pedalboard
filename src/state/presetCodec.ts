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

function normalizeRig(rawRig: unknown, catalog: RigPresetCatalog): RigPresetState {
  const source = isRecord(rawRig) ? rawRig : {};
  return {
    chain: normalizeChain(source.chain, catalog),
    amp: normalizeAmp(source.amp, catalog),
    cab: normalizeCab(source.cab, catalog),
    globals: normalizeGlobals(source.globals, catalog),
  };
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
