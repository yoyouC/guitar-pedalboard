import { defineWorkletEffect } from './workletEffect';

/**
 * 板式混响 ⚗:EMT-140 风格 FDN(预延迟 + 4 级输入扩散 + 环内 4 全通双延迟反馈,
 * 环内阻尼低通实现高频随时间衰减)。worklet 实现('plate-reverb'),加载失败兜底直通。
 */
export const plateEffect = defineWorkletEffect({
  id: 'plate',
  name: '板式混响 ⚗',
  color: '#9b59b6',
  params: [
    { key: 'time', label: 'TIME', min: 0.5, max: 6, step: 0.05, defaultValue: 2.5, unit: 's' },
    { key: 'damp', label: 'DAMP', min: 0, max: 100, step: 1, defaultValue: 40 },
    { key: 'preDelay', label: 'PREDELAY', min: 0, max: 100, step: 1, defaultValue: 0, unit: 'ms' },
    { key: 'mix', label: 'MIX', min: 0, max: 100, step: 1, defaultValue: 30, unit: '%' },
  ],
  processor: 'plate-reverb',
  fallbackWarn: '板式混响 worklet 未就绪,直通:',
});
