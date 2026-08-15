/**
 * FET 压缩(1176 风格)的 AudioWorklet 处理器(Blob 加载,免构建配置)。
 *
 * DSP 核见同目录 fetComp.dsp.js(链路说明也在那里)——经 `?raw` 取源码字符串,
 * 与下方 wrapper(parameterDescriptors / Processor 子类 / registerProcessor)
 * 拼装进 Blob(ADR-0001 语义不变,ADR-0003 双模式消费)。
 */
import { buildProcessorSource, createWorkletLoader } from '../workletLoader';
import resampleSource from './resample.dsp.js?raw';
import fetCompSource from './fetComp.dsp.js?raw';

const processorSource = buildProcessorSource(
  [resampleSource, fetCompSource],
  `
class WdfFet1176Processor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -20, minValue: -60, maxValue: 0 },
      { name: 'ratio', defaultValue: 1, minValue: 0, maxValue: 4 },
      { name: 'attack', defaultValue: 200, minValue: 20, maxValue: 800 },
      { name: 'release', defaultValue: 250, minValue: 50, maxValue: 1100 },
      { name: 'level', defaultValue: 1, minValue: 0, maxValue: 2 },
    ];
  }

  constructor() {
    super();
    this.engine = new WdfFet1176Engine(sampleRate);
  }

  process(inputs, outputs, params) {
    return this.engine.process(inputs, outputs, params);
  }
}

registerProcessor('wdf-fet1176', WdfFet1176Processor);
`,
);

/** 幂等加载(按 AudioContext 注册),使用前必须先 await */
export const loadFet1176 = createWorkletLoader(processorSource);
