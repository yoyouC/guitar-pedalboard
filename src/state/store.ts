import type { EffectDefinition } from '../audio/effects/types';
import { getEffectDef } from '../audio/effects';

/** 链条中的一个效果器实例(React 状态侧) */
export interface ChainItem {
  uid: string;
  effectId: string;
  enabled: boolean;
  values: Record<string, number>;
}

export function createChainItem(def: EffectDefinition): ChainItem {
  const values: Record<string, number> = {};
  for (const p of def.params) values[p.key] = p.defaultValue;
  return {
    uid: crypto.randomUUID(),
    effectId: def.id,
    enabled: true,
    values,
  };
}

/** 预设:不含 uid,加载时重新生成 */
export interface Preset {
  name: string;
  items: { effectId: string; enabled: boolean; values: Record<string, number> }[];
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
    items: chain.map(({ effectId, enabled, values }) => ({
      effectId,
      enabled,
      values: { ...values },
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
    };
  });
}
