import { defineWorkletEffect } from './workletEffect';

/**
 * 弹簧混响 ⚗:Fender Twin 弹簧箱风格(双弹簧反馈环 + 全通色散 + 阻尼低通)。
 * worklet 实现,加载失败兜底直通。干路恒为 1,MIX 控制湿路增益(同 delay/reverb 约定)。
 */
export const springReverbEffect = defineWorkletEffect({
  id: 'springreverb',
  name: '弹簧混响 ⚗',
  color: '#4e8d8d',
  params: [
    { key: 'time', label: 'TIME', min: 1, max: 4, step: 0.1, defaultValue: 2, unit: 's' },
    { key: 'dwell', label: 'DWELL', min: 0, max: 100, step: 1, defaultValue: 50 },
    { key: 'tone', label: 'TONE', min: 0, max: 100, step: 1, defaultValue: 50 },
    { key: 'mix', label: 'MIX', min: 0, max: 100, step: 1, defaultValue: 30, unit: '%' },
  ],
  processor: 'wdf-springreverb',
  fallbackWarn: '弹簧混响 worklet 未就绪,直通:',
});
