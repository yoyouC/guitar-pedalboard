import { LEVEL_DB_MAX, LEVEL_DB_MIN, levelDbToGain } from '../level';
import { WDF_4X_FIR_LATENCY } from '../latency';
import { defineWorkletEffect, withDbParam } from './workletEffect';

/**
 * 1176 FET 压缩 ⚗:超快启动(20~800µs)、4/8/12/20:1 步进比率 + ALL BUTTONS IN
 * 压限档、FET 输出级饱和谐波。worklet 实现,加载失败兜底直通。
 *
 * RATIO 为档位索引:0=4:1 1=8:1 2=12:1 3=20:1 4=ALL(极高比率+重饱和)。
 * LEVEL 为 dB 域补偿(-30~+6),update 时经 levelDbToGain 转线性增益。
 */
export const fet1176Effect = defineWorkletEffect({
  latency: WDF_4X_FIR_LATENCY,
  id: 'fet1176',
  name: '1176 FET 压缩 ⚗',
  color: '#31405c',
  params: [
    { key: 'threshold', label: 'THRESHOLD', min: -60, max: 0, step: 1, defaultValue: -20, unit: 'dB' },
    { key: 'ratio', label: 'RATIO', min: 0, max: 4, step: 1, defaultValue: 1 },
    { key: 'attack', label: 'ATTACK', min: 20, max: 800, step: 1, defaultValue: 200, unit: 'µs' },
    { key: 'release', label: 'RELEASE', min: 50, max: 1100, step: 5, defaultValue: 250, unit: 'ms' },
    { key: 'level', label: 'LEVEL', min: LEVEL_DB_MIN, max: LEVEL_DB_MAX, step: 0.5, defaultValue: 0, unit: 'dB' },
  ],
  processor: 'wdf-fet1176',
  fallbackWarn: '1176 FET 压缩 worklet 未就绪,直通:',
  initParams: { level: 1 },
  mapParam: withDbParam('level', levelDbToGain),
});
