import { defineWorkletEffect } from './workletEffect';

/**
 * Noise Gate —— 基于 AudioWorklet('noise-gate')的噪声门。
 * 门限以下信号被衰减;attack/release 控制开门/关门速度。
 * 若 worklet 处理器未加载(构造抛错),兜底为直通。
 */
export const noiseGateEffect = defineWorkletEffect({
  id: 'noiseGate',
  name: 'Noise Gate',
  color: '#8a8f98',
  params: [
    {
      key: 'threshold',
      label: 'Threshold',
      min: -90,
      max: 0,
      step: 1,
      defaultValue: -50,
      unit: 'dB',
    },
    {
      key: 'attack',
      label: 'Attack',
      min: 0.001,
      max: 0.05,
      step: 0.001,
      defaultValue: 0.005,
      unit: 's',
    },
    {
      key: 'release',
      label: 'Release',
      min: 0.01,
      max: 0.5,
      step: 0.01,
      defaultValue: 0.08,
      unit: 's',
    },
  ],
  processor: 'noise-gate',
  fallbackWarn: '[noiseGate] AudioWorklet "noise-gate" 不可用,回退为直通',
  smoothing: 0.02,
  suspendOnDispose: true,
});
