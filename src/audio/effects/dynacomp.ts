import { LEVEL_DB_MAX, LEVEL_DB_MIN, levelDbToGain } from '../level';
import { defineWorkletEffect, withDbParam } from './workletEffect';

/**
 * Dyna Comp 压缩 ⚗:MXR Dyna Comp 风格 OTA 压缩(反馈式,~11:1,
 * 固定快启动 + 中速释放,标志性"泵感"起音与延音)。
 * worklet 实现,加载失败兜底直通。
 */
export const dynaCompEffect = defineWorkletEffect({
  id: 'dynacomp',
  name: 'Dyna Comp 压缩 ⚗',
  color: '#c0392b',
  params: [
    { key: 'sensitivity', label: 'SENSITIVITY', min: 0, max: 100, step: 1, defaultValue: 50 },
    { key: 'level', label: 'LEVEL', min: LEVEL_DB_MIN, max: LEVEL_DB_MAX, step: 0.5, defaultValue: 0, unit: 'dB' },
  ],
  processor: 'wdf-dynacomp',
  fallbackWarn: 'Dyna Comp worklet 未就绪,直通:',
  initParams: { level: 1 },
  mapParam: withDbParam('level', levelDbToGain),
});
