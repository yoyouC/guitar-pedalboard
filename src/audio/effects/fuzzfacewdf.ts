import { LEVEL_DB_MAX, LEVEL_DB_MIN, levelDbToGain } from '../level';
import { WDF_4X_FIR_LATENCY } from '../latency';
import { defineWorkletEffect, withDbParam } from './workletEffect';

/**
 * Fuzz Face WDF ⚗:经典两级锗管法兹的白盒电路建模(简化 Ebers-Moll 双 BJT,
 * 100k 电压反馈偏置,4x 过采样)。worklet 实现,加载失败兜底直通。
 */
export const fuzzfaceWdfEffect = defineWorkletEffect({
  latency: WDF_4X_FIR_LATENCY,
  id: 'fuzzfacewdf',
  name: 'Fuzz Face WDF ⚗',
  color: '#a93226',
  params: [
    { key: 'fuzz', label: 'FUZZ', min: 0, max: 100, step: 1, defaultValue: 70 },
    { key: 'level', label: 'LEVEL', min: LEVEL_DB_MIN, max: LEVEL_DB_MAX, step: 0.5, defaultValue: 0, unit: 'dB' },
  ],
  processor: 'wdf-fuzzface',
  fallbackWarn: 'Fuzz Face WDF worklet 未就绪,直通:',
  initParams: { level: 1 },
  mapParam: withDbParam('level', levelDbToGain),
});
