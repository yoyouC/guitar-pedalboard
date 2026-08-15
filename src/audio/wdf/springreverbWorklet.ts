/**
 * 弹簧混响(Spring Reverb,Fender Twin 弹簧箱风格)AudioWorklet 处理器
 * (Blob 内联,免构建配置)。
 *
 * DSP 核见同目录 springReverb.dsp.js(链路说明也在那里)——经 `?raw` 取源码
 * 字符串,与下方 wrapper(parameterDescriptors / Processor 子类 /
 * registerProcessor)拼装进 Blob(ADR-0001 语义不变,ADR-0003 双模式消费)。
 */
import { buildProcessorSource, createWorkletLoader } from '../workletLoader';
import springReverbSource from './springReverb.dsp.js?raw';

const processorSource = buildProcessorSource(
  [springReverbSource],
  `
class WdfSpringReverbProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'time', defaultValue: 2.0, minValue: 1, maxValue: 4 },
      { name: 'dwell', defaultValue: 50, minValue: 0, maxValue: 100 },
      { name: 'tone', defaultValue: 50, minValue: 0, maxValue: 100 },
      { name: 'mix', defaultValue: 30, minValue: 0, maxValue: 100 },
    ];
  }

  constructor() {
    super();
    this.engine = new WdfSpringReverbEngine(sampleRate);
  }

  process(inputs, outputs, params) {
    return this.engine.process(inputs, outputs, params);
  }
}

registerProcessor('wdf-springreverb', WdfSpringReverbProcessor);
`,
);

/** 幂等加载(按 AudioContext 注册),使用前必须先 await */
export const loadSpringReverbWdf = createWorkletLoader(processorSource);
