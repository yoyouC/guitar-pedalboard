/**
 * WDF 版 Big Muff Pi 的 AudioWorklet 处理器(Blob 内联,免构建配置)。
 *
 * DSP 核见同目录 bigmuff.dsp.js(链路说明也在那里)——经 `?raw` 取源码字符串,
 * 与下方 wrapper(parameterDescriptors / Processor 子类 / registerProcessor)
 * 拼装进 Blob(ADR-0001 语义不变,ADR-0003 双模式消费)。
 */
import { buildProcessorSource, createWorkletLoader } from '../workletLoader';
import resampleSource from './resample.dsp.js?raw';
import diodeClipperSource from './diodeClipper.dsp.js?raw';
import bigmuffSource from './bigmuff.dsp.js?raw';

const processorSource = buildProcessorSource(
  [resampleSource, diodeClipperSource, bigmuffSource],
  `
class WdfBigMuffProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'sustain', defaultValue: 50, minValue: 0, maxValue: 100 },
      { name: 'tone', defaultValue: 50, minValue: 0, maxValue: 100 },
      { name: 'level', defaultValue: 1, minValue: 0, maxValue: 2 },
    ];
  }

  constructor() {
    super();
    this.engine = new WdfBigMuffEngine(sampleRate);
  }

  process(inputs, outputs, params) {
    return this.engine.process(inputs, outputs, params);
  }
}

registerProcessor('wdf-bigmuff', WdfBigMuffProcessor);
`,
);

/** 幂等加载(按 AudioContext 注册),使用前必须先 await */
export const loadBigMuffWdf = createWorkletLoader(processorSource);
