/**
 * 微光混响(Shimmer Reverb)的 AudioWorklet 处理器(Blob 加载,免构建配置)。
 *
 * DSP 核见同目录 shimmerReverb.dsp.js(链路说明也在那里)——经 `?raw` 取源码
 * 字符串,与下方 wrapper(parameterDescriptors / Processor 子类 /
 * registerProcessor)拼装进 Blob(ADR-0001 语义不变,ADR-0003 双模式消费)。
 */
import { buildProcessorSource, createWorkletLoader } from '../workletLoader';
import shimmerReverbSource from './shimmerReverb.dsp.js?raw';

const processorSource = buildProcessorSource(
  [shimmerReverbSource],
  `
class ShimmerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'time', defaultValue: 4.5, minValue: 2, maxValue: 8 },
      { name: 'shimmer', defaultValue: 40, minValue: 0, maxValue: 100 },
      { name: 'damp', defaultValue: 40, minValue: 0, maxValue: 100 },
      { name: 'mix', defaultValue: 35, minValue: 0, maxValue: 100 },
    ];
  }

  constructor() {
    super();
    this.engine = new WdfShimmerEngine(sampleRate);
  }

  process(inputs, outputs, params) {
    return this.engine.process(inputs, outputs, params);
  }
}

registerProcessor('wdf-shimmer', ShimmerProcessor);
`,
);

/** 幂等加载(按 AudioContext 注册),使用前必须先 await */
export const loadShimmerWdf = createWorkletLoader(processorSource);
