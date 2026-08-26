import { LEVEL_DB_MAX, LEVEL_DB_MIN, levelDbToGain } from '../level';
import { WDF_4X_FIR_LATENCY } from '../latency';
import { defineWorkletEffect, withDbParam } from './workletEffect';

/**
 * DS-1 WDF ⚗:与内置 distortion(WaveShaper 近似)并存的 WDF 精确电路建模版
 * (Boss DS-1:BJT 前级 → 运放可变增益 → 1N4148 对地削波 → LP/HP 交叉淡化 TONE)。
 * worklet 实现,加载失败兜底直通。
 */
export const ds1WdfEffect = defineWorkletEffect({
  latency: WDF_4X_FIR_LATENCY,
  id: 'ds1wdf',
  name: 'DS-1 WDF ⚗',
  color: '#d97218',
  params: [
    { key: 'dist', label: 'DIST', min: 0, max: 100, step: 1, defaultValue: 50 },
    { key: 'tone', label: 'TONE', min: 0, max: 100, step: 1, defaultValue: 50 },
    { key: 'level', label: 'LEVEL', min: LEVEL_DB_MIN, max: LEVEL_DB_MAX, step: 0.5, defaultValue: 0, unit: 'dB' },
  ],
  processor: 'wdf-ds1',
  fallbackWarn: 'DS-1 WDF worklet 未就绪,直通:',
  initParams: { level: 1 },
  mapParam: withDbParam('level', levelDbToGain),
});
