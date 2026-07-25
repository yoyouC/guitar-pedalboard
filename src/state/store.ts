import type { EffectDefinition } from '../audio/effects/types';
import { getEffectDef } from '../audio/effects';

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

/** 预设:不含 uid,加载时重新生成 */
export interface Preset {
  name: string;
  items: { effectId: string; enabled: boolean; values: Record<string, number>; post?: boolean }[];
}

const STORAGE_KEY = 'guitar-pedalboard-presets';

export function loadPresets(): Preset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Preset[]) : [];
  } catch {
    return [];
  }
}

export function savePresets(presets: Preset[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
}

export function chainToPreset(name: string, chain: ChainItem[]): Preset {
  return {
    name,
    items: chain.map(({ effectId, enabled, values, post }) => ({
      effectId,
      enabled,
      values: { ...values },
      post,
    })),
  };
}

export function presetToChain(preset: Preset): ChainItem[] {
  return preset.items.map((item) => {
    const def = getEffectDef(item.effectId);
    const base = createChainItem(def);
    // 合并保存值,缺失键回落到默认(兼容旧预设);
    // 并钳制到当前参数范围:旧预设的值域可能已变更(如 Level 曾为 0~100),
    // 越界值会映射成危险增益
    const values = { ...base.values, ...item.values };
    for (const p of def.params) {
      if (p.key in values) {
        values[p.key] = Math.min(p.max, Math.max(p.min, values[p.key]));
      }
    }
    return {
      ...base,
      enabled: item.enabled,
      values,
      // 旧预设无 post 字段时用类型默认(兼容)
      post: item.post ?? base.post,
    };
  });
}
