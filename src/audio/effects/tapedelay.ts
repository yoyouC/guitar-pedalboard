import { defineWorkletEffect } from './workletEffect';

/**
 * 磁带延迟 ⚗:Echoplex EP-3 风格磁带回声。
 * 录制软削波(磁带饱和)+ wow/flutter 音高漂移 + 每次重复高频损失与逐次饱和,
 * FEEDBACK>100% 可自激振荡(环内软削波限幅,有界不发散)。
 * worklet 实现(src/audio/wdf/tapedelayWorklet.ts),加载失败兜底直通。
 */
export const tapeDelayEffect = defineWorkletEffect({
  id: 'tapedelay',
  name: '磁带延迟 ⚗',
  color: '#b5651d',
  params: [
    { key: 'time', label: 'TIME', min: 50, max: 1000, step: 1, defaultValue: 400, unit: 'ms' },
    { key: 'feedback', label: 'FEEDBACK', min: 0, max: 110, step: 1, defaultValue: 40, unit: '%' },
    { key: 'wow', label: 'WOW', min: 0, max: 100, step: 1, defaultValue: 30 },
    { key: 'saturation', label: 'SATURATION', min: 0, max: 100, step: 1, defaultValue: 40 },
    { key: 'mix', label: 'MIX', min: 0, max: 100, step: 1, defaultValue: 30, unit: '%' },
  ],
  processor: 'wdf-tapedelay',
  fallbackWarn: '磁带延迟 worklet 未就绪,直通:',
});
