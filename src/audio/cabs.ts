import type { EffectDefinition } from './effects/types';
import { LEVEL_DB_MAX, LEVEL_DB_MIN } from './level';
import { CAB_IR_ASSETS_READY } from './cabIrManifest';
import { CAB_IR_RUNTIME_DEF } from './cabIrRuntime';

interface CabDefinitionMeta {
  id: string;
  name: string;
  color: string;
  level: number;
}

const CAB_DEFINITIONS: readonly CabDefinitionMeta[] = [
  { id: 'open1x12', name: '1x12 Open', color: '#8a8f98', level: -1 },
  { id: 'blue2x12', name: '2x12 Blue', color: '#b03a2e', level: -1.5 },
  { id: 'gb4x12', name: '4x12 Greenback', color: '#c8a24a', level: -2 },
  { id: 'v304x12', name: '4x12 V30', color: '#5d6d7e', level: -2 },
  { id: 'customIr', name: 'Custom IR', color: '#7467a8', level: -6 },
];

/**
 * 五个目录项共享同一个稳定 Convolver Runtime；区别只存在于 canonical IR 身份、
 * 展示元数据和初始电平。旧 Biquad Cab DSP 已在四个生产 WAV 获批后移除。
 */
function makeCabDef(meta: CabDefinitionMeta): EffectDefinition {
  return {
    ...CAB_IR_RUNTIME_DEF,
    id: meta.id,
    name: meta.name,
    color: meta.color,
    params: [
      {
        key: 'level', label: 'LEVEL', min: LEVEL_DB_MIN, max: LEVEL_DB_MAX,
        step: 0.5, defaultValue: meta.level, unit: 'dB',
      },
    ],
  };
}

/** 箱体目录(复用效果器接口)。 */
export const CAB_REGISTRY: EffectDefinition[] = CAB_DEFINITIONS.map(makeCabDef);

/** 发布清单不完整时不暴露 Custom IR；生产发布检查会同时阻断不完整资产。 */
export const CAB_SELECTOR_REGISTRY = CAB_IR_ASSETS_READY
  ? CAB_REGISTRY
  : CAB_REGISTRY.filter((definition) => definition.id !== 'customIr');

export function getCabDef(id: string): EffectDefinition {
  const def = CAB_REGISTRY.find((candidate) => candidate.id === id);
  if (!def) throw new Error(`未知箱体型号: ${id}`);
  return def;
}
