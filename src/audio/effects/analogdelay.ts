import { defineWorkletEffect } from './workletEffect';

/**
 * 模拟延迟 ⚗:BBD 白盒建模(Boss DM-2 / Memory Man 风格)。
 * 逐级低通的变暗重复、本底噪声、可选慢速调制(重复音 vibrato)。
 * worklet 实现(src/audio/wdf/analogdelayWorklet.ts),加载失败兜底直通。
 * 注:处理器名 'bbd-analog-delay' 是离群值(非 id 派生),原样保留。
 */
export const analogDelayEffect = defineWorkletEffect({
  id: 'analogdelay',
  name: '模拟延迟 ⚗',
  color: '#b0793a',
  params: [
    { key: 'time', label: 'TIME', min: 20, max: 600, step: 1, defaultValue: 300, unit: 'ms' },
    { key: 'feedback', label: 'FEEDBACK', min: 0, max: 95, step: 1, defaultValue: 40, unit: '%' },
    { key: 'tone', label: 'TONE', min: 0, max: 100, step: 1, defaultValue: 55 },
    { key: 'mod', label: 'MOD', min: 0, max: 100, step: 1, defaultValue: 0, unit: '%' },
    { key: 'mix', label: 'MIX', min: 0, max: 100, step: 1, defaultValue: 35, unit: '%' },
  ],
  processor: 'bbd-analog-delay',
  fallbackWarn: '模拟延迟 worklet 未就绪,直通:',
});
