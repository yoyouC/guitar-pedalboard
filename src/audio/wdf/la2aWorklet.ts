/**
 * LA-2A 风格光学压缩的 AudioWorklet 处理器(Blob 内联,免构建配置)。
 *
 * DSP 核见同目录 la2aOpto.dsp.js(链路说明也在那里)——经 `?raw` 取源码字符串,
 * 与下方 wrapper(parameterDescriptors / Processor 子类 / registerProcessor)
 * 拼装进 Blob(ADR-0001 语义不变,ADR-0003 双模式消费)。
 */
import { buildProcessorSource, createWorkletLoader } from '../workletLoader';
import la2aOptoSource from './la2aOpto.dsp.js?raw';

const processorSource = buildProcessorSource(
  [la2aOptoSource],
  `
class La2aOptoProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'reduction', defaultValue: 30, minValue: 0, maxValue: 100 },
      { name: 'gain', defaultValue: 1, minValue: 0, maxValue: 40 },
      { name: 'mode', defaultValue: 0, minValue: 0, maxValue: 1 },
    ];
  }

  constructor() {
    super();
    this.engine = new La2aOptoEngine(sampleRate);
  }

  process(inputs, outputs, params) {
    return this.engine.process(inputs, outputs, params);
  }
}

registerProcessor('opto-la2a', La2aOptoProcessor);
`,
);

/** 幂等加载(按 AudioContext 注册),使用前必须先 await */
export const loadLa2aOpto = createWorkletLoader(processorSource);
