import { LEVEL_DB_MAX, LEVEL_DB_MIN, levelDbToGain } from '../level';
import { WDF_4X_FIR_LATENCY } from '../latency';
import { defineWorkletEffect, withDbParam } from './workletEffect';

/**
 * Klon WDF ⚗:Klon Centaur 的 WDF 白盒电路建模版
 * (运放增益级 + 锗管对地削波 + GAIN 联动干湿混合 + Treble 高架)。
 * worklet 实现,加载失败兜底直通。
 */
export const klonWdfEffect = defineWorkletEffect({
  latency: WDF_4X_FIR_LATENCY,
  id: 'klonwdf',
  name: 'Klon WDF ⚗',
  color: '#b8860b',
  params: [
    { key: 'gain', label: 'GAIN', min: 0, max: 100, step: 1, defaultValue: 30 },
    { key: 'treble', label: 'TREBLE', min: 0, max: 100, step: 1, defaultValue: 50 },
    { key: 'level', label: 'LEVEL', min: LEVEL_DB_MIN, max: LEVEL_DB_MAX, step: 0.5, defaultValue: 0, unit: 'dB' },
  ],
  processor: 'wdf-klon',
  fallbackWarn: 'Klon WDF worklet 未就绪,直通:',
  initParams: { level: 1 },
  mapParam: withDbParam('level', levelDbToGain),
});
