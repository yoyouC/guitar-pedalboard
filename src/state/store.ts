import type { EffectDefinition } from '../audio/effects/types';
import { EFFECT_REGISTRY } from '../audio/effects';
import { AMP_REGISTRY } from '../audio/amps';
import { CAB_REGISTRY } from '../audio/cabs';
import { AMP_CATEGORIES } from '../audio/ampCategories';
import {
  createRigPreset,
  exportRigPresetsJson,
  importRigPresetsJson,
  restoreRigPreset,
  type RigPreset,
  type RigPresetCatalog,
  type RigPresetState,
  type RestoredRigPresetState,
} from './presetCodec';

/** 链条中的一个效果器实例(React 状态侧) */
export interface ChainItem {
  uid: string;
  effectId: string;
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

const RIG_PRESET_CATALOG: RigPresetCatalog = {
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

export type Preset = RigPreset;
export type FullRigState = RigPresetState;
export type RestoredFullRigState = RestoredRigPresetState;

const STORAGE_KEY = 'guitar-pedalboard-presets';

export function loadPresets(): Preset[] {
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

export function savePresets(presets: Preset[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
}

export function currentRigToPreset(name: string, rig: FullRigState): Preset {
  return createRigPreset(name, rig, RIG_PRESET_CATALOG);
}

export function presetToRig(preset: Preset): RestoredFullRigState {
  return restoreRigPreset(preset, RIG_PRESET_CATALOG);
}

export function exportPresetsJson(presets: Preset[]): string {
  return exportRigPresetsJson(presets);
}

export function importPresetsJson(text: string): Preset[] {
  return importRigPresetsJson(text, RIG_PRESET_CATALOG);
}
