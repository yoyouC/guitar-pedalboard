/**
 * WDF JC-120(Roland Jazz Chorus 风格,全固态极致清音)AudioWorklet 处理器。
 * Blob 加载,免构建配置。
 *
 * DSP 核见同目录 jc120Core.dsp.js(链路说明也在那里)——经 `?raw` 取源码
 * 字符串,与下方 wrapper(parameterDescriptors / Processor 子类 /
 * registerProcessor)拼装进 Blob(ADR-0001 语义不变,ADR-0003 双模式消费)。
 * MASTER 与三段音色栈在 AmpDef 侧用原生节点。
 */
import { buildProcessorSource, createWorkletLoader } from '../workletLoader';
import resampleSource from './resample.dsp.js?raw';
import jc120Source from './jc120Core.dsp.js?raw';

const processorSource = buildProcessorSource(
  [resampleSource, jc120Source],
  `
class WdfJc120Processor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'gain', defaultValue: 40, minValue: 0, maxValue: 100 },
      { name: 'chorus', defaultValue: 0, minValue: 0, maxValue: 1 },
    ];
  }

  constructor() {
    super();
    this.engine = new WdfJc120Engine(sampleRate);
  }

  process(inputs, outputs, params) {
    return this.engine.process(inputs, outputs, params);
  }
}

registerProcessor('wdf-jc120', WdfJc120Processor);
`,
);

/** 幂等加载(按 AudioContext 注册),使用前必须先 await */
export const loadJc120Wdf = createWorkletLoader(processorSource);
