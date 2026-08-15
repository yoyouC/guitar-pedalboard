/**
 * WDF 版 Fuzz Face 的 AudioWorklet 处理器(Blob 装配,免构建配置)。
 *
 * DSP 核见同目录 fuzzFaceStage.dsp.js(链路说明也在那里)——经 `?raw` 取源码
 * 字符串,与下方 wrapper(parameterDescriptors / Processor 子类 /
 * registerProcessor)拼装进 Blob(ADR-0001 语义不变,ADR-0003 双模式消费)。
 */
import { buildProcessorSource, createWorkletLoader } from '../workletLoader';
import resampleSource from './resample.dsp.js?raw';
import fuzzFaceSource from './fuzzFaceStage.dsp.js?raw';

const processorSource = buildProcessorSource(
  [resampleSource, fuzzFaceSource],
  `
class WdfFuzzFaceProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'fuzz', defaultValue: 70, minValue: 0, maxValue: 100 },
      { name: 'level', defaultValue: 1, minValue: 0, maxValue: 2 },
    ];
  }

  constructor() {
    super();
    this.engine = new WdfFuzzFaceEngine(sampleRate);
  }

  process(inputs, outputs, params) {
    return this.engine.process(inputs, outputs, params);
  }
}

registerProcessor('wdf-fuzzface', WdfFuzzFaceProcessor);
`,
);

/** 幂等加载(按 AudioContext 注册),使用前必须先 await */
export const loadFuzzFaceWdf = createWorkletLoader(processorSource);
