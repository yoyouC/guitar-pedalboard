/**
 * 板式混响(Plate Reverb,EMT-140 风格)的 AudioWorklet 处理器(Blob 内联,免构建配置)。
 *
 * DSP 核见同目录 plateReverb.dsp.js(链路说明也在那里)——经 `?raw` 取源码
 * 字符串,与下方 wrapper(parameterDescriptors / Processor 子类 /
 * registerProcessor)拼装进 Blob(ADR-0001 语义不变,ADR-0003 双模式消费)。
 */
import { buildProcessorSource, createWorkletLoader } from '../workletLoader';
import plateReverbSource from './plateReverb.dsp.js?raw';

const processorSource = buildProcessorSource(
  [plateReverbSource],
  `
class PlateReverbProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'time', defaultValue: 2.5, minValue: 0.5, maxValue: 6 },
      { name: 'damp', defaultValue: 40, minValue: 0, maxValue: 100 },
      { name: 'preDelay', defaultValue: 0, minValue: 0, maxValue: 100 },
      { name: 'mix', defaultValue: 30, minValue: 0, maxValue: 100 },
    ];
  }

  constructor() {
    super();
    this.engine = new PlateReverbEngine(sampleRate);
  }

  process(inputs, outputs, params) {
    return this.engine.process(inputs, outputs, params);
  }
}

registerProcessor('plate-reverb', PlateReverbProcessor);
`,
);

/** 幂等加载(按 AudioContext 注册),使用前必须先 await */
export const loadPlateReverb = createWorkletLoader(processorSource);
