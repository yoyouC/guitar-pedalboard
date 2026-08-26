import { LEVEL_DB_MAX, LEVEL_DB_MIN, levelDbToGain } from '../level';
import { WDF_4X_FIR_LATENCY } from '../latency';
import { defineWorkletEffect, withDbParam } from './workletEffect';

/**
 * Big Muff WDF ⚗:EHX Big Muff Pi(V3)的 WDF 精确电路建模版。
 * 两级 BJT 增益 + 1N4148 对地削波 + 标志性 LP/HP 交叉淡化 TONE。
 * worklet 实现,加载失败兜底直通。
 */
export const bigmuffWdfEffect = defineWorkletEffect({
  latency: WDF_4X_FIR_LATENCY,
  id: 'bigmuffwdf',
  name: 'Big Muff WDF ⚗',
  color: '#b03a2e',
  params: [
    { key: 'sustain', label: 'SUSTAIN', min: 0, max: 100, step: 1, defaultValue: 50 },
    { key: 'tone', label: 'TONE', min: 0, max: 100, step: 1, defaultValue: 50 },
    { key: 'level', label: 'LEVEL', min: LEVEL_DB_MIN, max: LEVEL_DB_MAX, step: 0.5, defaultValue: 0, unit: 'dB' },
  ],
  processor: 'wdf-bigmuff',
  fallbackWarn: 'Big Muff WDF worklet 未就绪,直通:',
  initParams: { level: 1 },
  mapParam: withDbParam('level', levelDbToGain),
});
