import { LEVEL_DB_MAX, LEVEL_DB_MIN, levelDbToGain } from '../level';
import { defineWorkletEffect, withDbParam } from './workletEffect';

/**
 * TS808 WDF ⚗:与内置 ts808(双二阶近似)并存的 WDF 精确电路建模版。
 * worklet 实现,加载失败兜底直通。
 */
export const ts808WdfEffect = defineWorkletEffect({
  id: 'ts808wdf',
  name: 'TS808 WDF ⚗',
  color: '#1f6e43',
  params: [
    { key: 'drive', label: 'DRIVE', min: 0, max: 100, step: 1, defaultValue: 45 },
    { key: 'tone', label: 'TONE', min: 0, max: 100, step: 1, defaultValue: 55 },
    { key: 'level', label: 'LEVEL', min: LEVEL_DB_MIN, max: LEVEL_DB_MAX, step: 0.5, defaultValue: 0, unit: 'dB' },
  ],
  processor: 'wdf-ts808',
  fallbackWarn: 'TS808 WDF worklet 未就绪,直通:',
  initParams: { level: 1 },
  mapParam: withDbParam('level', levelDbToGain),
});
