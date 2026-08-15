import type { EffectDefinition } from './effects/types';
import { createNamWasmAmp, NAM_AMP_DEFAULTS } from './namWasm';
import { LEVEL_DB_MAX, LEVEL_DB_MIN } from './level';

const AMP_PARAMS = (d: typeof NAM_AMP_DEFAULTS) => [
  { key: 'gain', label: 'GAIN', min: 0, max: 100, step: 1, defaultValue: d.gain },
  { key: 'bass', label: 'BASS', min: 0, max: 100, step: 1, defaultValue: d.bass },
  { key: 'mid', label: 'MID', min: 0, max: 100, step: 1, defaultValue: d.mid },
  { key: 'treble', label: 'TREBLE', min: 0, max: 100, step: 1, defaultValue: d.treble },
  { key: 'presence', label: 'PRESENCE', min: 0, max: 100, step: 1, defaultValue: d.presence },
  { key: 'master', label: 'MASTER', min: LEVEL_DB_MIN, max: LEVEL_DB_MAX, step: 0.5, defaultValue: d.master, unit: 'dB' },
];

/** 箱头目录(复用效果器接口,UI 与引擎一视同仁);仅 NAM 引擎(见 namWasm.ts) */
export const AMP_REGISTRY: EffectDefinition[] = [
  // NAM 箱头:NAM Core WASM 全架构(WaveNet/LSTM/…)
  {
    id: 'nam-wasm',
    name: 'NAM WaveNet',
    color: '#2e5a8b',
    params: AMP_PARAMS(NAM_AMP_DEFAULTS),
    create: createNamWasmAmp,
  },
];

export function getAmpDef(id: string): EffectDefinition {
  const def = AMP_REGISTRY.find((d) => d.id === id);
  if (!def) throw new Error(`未知箱头型号: ${id}`);
  return def;
}
