import type { EffectDefinition } from '../audio/effects/types';
import { EFFECT_REGISTRY } from '../audio/effects';
import { AMP_REGISTRY } from '../audio/amps';
import { CAB_REGISTRY } from '../audio/cabs';
import { AMP_CATEGORIES } from '../audio/ampCategories';
import {
  createRigPreset,
  exportRigPresetsJson,
  importRigPresetsJson,
  normalizeSnapshot,
  restoreRigPreset,
  type RigPreset,
  type RigPresetCatalog,
  type RigPresetState,
  type RestoredRigPresetState,
  type Snapshot,
} from './presetCodec';

/** 链条中的一个效果器实例(React 状态侧) */
export interface ChainItem {
  uid: string;
  effectId: string;
  modelRef?: string;
  modelId?: string;
  enabled: boolean;
  values: Record<string, number>;
  /** false = 箱头之前(前置);true = 箱头之后、箱体之前(FX Loop) */
  post: boolean;
}

/** 默认进 FX Loop 的效果器类型(延迟/混响类惯例) */
const FX_LOOP_EFFECTS = new Set([
  'delay',
  'reverb',
  'springreverb',
  'plate',
  'shimmer',
  'analogdelay',
  'tapedelay',
  'pingpong',
]);

/** 真实目录:由效果/箱头/箱体注册表与箱头分类构建,所有 normalize 路径共用(ADR-0006) */
export const RIG_PRESET_CATALOG: RigPresetCatalog = {
  effects: EFFECT_REGISTRY.map((definition) => ({
    id: definition.id,
    params: definition.params,
    defaultPost: FX_LOOP_EFFECTS.has(definition.id),
  })),
  amps: AMP_REGISTRY.map((definition) => ({
    id: definition.id,
    params: definition.params,
  })),
  cabs: CAB_REGISTRY.map((definition) => ({
    id: definition.id,
    params: definition.params,
  })),
  ampModels: AMP_CATEGORIES.flatMap((category) =>
    category.models.map((model) => ({
      key: model.key,
      categoryId: category.id,
      ampId: model.kind === 'builtin' ? model.ref : 'nam-wasm',
    })),
  ),
  ampCategoryIds: AMP_CATEGORIES.map((category) => category.id),
  defaults: {
    ampModelKey: 'builtin:crunch',
    cabId: 'gb4x12',
    inputGain: 1,
    masterVolume: 0.5,
  },
};

export function createChainItem(def: EffectDefinition): ChainItem {
  const values: Record<string, number> = {};
  for (const p of def.params) values[p.key] = p.defaultValue;
  return {
    uid: crypto.randomUUID(),
    effectId: def.id,
    enabled: true,
    values,
    post: FX_LOOP_EFFECTS.has(def.id),
  };
}

/** 初始型号簿记:每个箱头分类记住该类的第一个型号(catalog 单点) */
export function defaultAmpModelKeys(): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const model of RIG_PRESET_CATALOG.ampModels) {
    if (!(model.categoryId in keys)) keys[model.categoryId] = model.key;
  }
  return keys;
}

const STORAGE_KEY = 'guitar-pedalboard-presets';

export function loadPresets(): RigPreset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const presets = importRigPresetsJson(raw, RIG_PRESET_CATALOG);
    // 首次读取旧版 chain-only 数据时立即写回 v2，后续不必重复迁移。
    const migrated = JSON.stringify(presets);
    if (raw !== migrated) localStorage.setItem(STORAGE_KEY, migrated);
    return presets;
  } catch {
    return [];
  }
}

export function savePresets(presets: RigPreset[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
}

export function currentRigToPreset(name: string, rig: RigPresetState): RigPreset {
  return createRigPreset(name, rig, RIG_PRESET_CATALOG);
}

export function presetToRig(preset: RigPreset): RestoredRigPresetState {
  return restoreRigPreset(preset, RIG_PRESET_CATALOG);
}

export function exportPresetsJson(presets: RigPreset[]): string {
  return exportRigPresetsJson(presets);
}

export function importPresetsJson(text: string): RigPreset[] {
  return importRigPresetsJson(text, RIG_PRESET_CATALOG);
}

const SNAPSHOT_KEY = 'guitar-pedalboard-snapshots';
export const SNAPSHOT_COUNT = 4;

function emptySnapshotSlots(): (Snapshot | null)[] {
  return Array(SNAPSHOT_COUNT).fill(null);
}

/**
 * 读取快照槽位:逐槽位经 normalizeSnapshot 宽容校验(ADR-0006)——
 * 坏槽位置 null(旧行为是裸奔进 applyRig 才 throw),槽位数截断/补齐到 SNAPSHOT_COUNT。
 */
export function loadSnapshots(): (Snapshot | null)[] {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return emptySnapshotSlots();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return emptySnapshotSlots();
    const slots = parsed
      .slice(0, SNAPSHOT_COUNT)
      .map((slot): Snapshot | null => (slot === null ? null : normalizeSnapshot(slot, RIG_PRESET_CATALOG)));
    while (slots.length < SNAPSHOT_COUNT) slots.push(null);
    return slots;
  } catch {
    return emptySnapshotSlots();
  }
}

export function saveSnapshots(snapshots: (Snapshot | null)[]): void {
  localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshots));
}
