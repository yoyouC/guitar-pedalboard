import { dbToGain } from '../level';
import { defineWorkletEffect, withDbParam } from './workletEffect';

/**
 * LA-2A 光学压缩 ⚗:T4B 光电池白盒建模(软拐点 + 程序相关两段式释放)。
 * worklet 实现('opto-la2a'),加载失败兜底直通。
 */
export const la2aEffect = defineWorkletEffect({
  id: 'la2a',
  name: 'LA-2A 光学压缩 ⚗',
  color: '#c9862d',
  params: [
    { key: 'reduction', label: 'REDUCTION', min: 0, max: 100, step: 1, defaultValue: 30 },
    { key: 'gain', label: 'GAIN', min: 0, max: 30, step: 0.5, defaultValue: 0, unit: 'dB' },
    { key: 'mode', label: 'MODE', min: 0, max: 1, step: 1, defaultValue: 0 },
  ],
  processor: 'opto-la2a',
  fallbackWarn: 'LA-2A worklet 未就绪,直通:',
  initParams: { gain: 1 },
  // GAIN 为 dB 域 → 线性增益
  mapParam: withDbParam('gain', dbToGain),
});
