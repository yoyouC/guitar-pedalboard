import { LEVEL_DB_MAX, LEVEL_DB_MIN, levelDbToGain } from '../level';
import { WDF_4X_FIR_LATENCY } from '../latency';
import { defineWorkletEffect, withDbParam } from './workletEffect';

/**
 * RAT WDF ⚗:与内置 rat(双二阶+波形表近似)并存的 WDF 精确电路建模版。
 * 可变增益运放 + 1N914 对地硬削波 + 反向 FILTER,worklet 实现,加载失败兜底直通。
 */
export const ratWdfEffect = defineWorkletEffect({
  latency: WDF_4X_FIR_LATENCY,
  id: 'ratwdf',
  name: 'RAT WDF ⚗',
  color: '#26262a',
  params: [
    { key: 'drive', label: 'DIST', min: 0, max: 100, step: 1, defaultValue: 55 },
    { key: 'filter', label: 'FILTER', min: 0, max: 100, step: 1, defaultValue: 35 },
    { key: 'level', label: 'LEVEL', min: LEVEL_DB_MIN, max: LEVEL_DB_MAX, step: 0.5, defaultValue: 0, unit: 'dB' },
  ],
  processor: 'wdf-rat',
  fallbackWarn: 'RAT WDF worklet 未就绪,直通:',
  initParams: { level: 1 },
  mapParam: withDbParam('level', levelDbToGain),
});
