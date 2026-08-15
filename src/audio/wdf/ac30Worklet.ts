/**
 * WDF AC30(Vox Top Boost 风格)箱头的 AudioWorklet 处理器(Blob 内联,免构建配置)。
 *
 * DSP 核见同目录 ac30Core.dsp.js(链路说明、CathodeFollower 与二分法栅流
 * 钳位的分叉原因也在那里)——经 `?raw` 取源码字符串,与下方 wrapper
 * (parameterDescriptors / Processor 子类 / registerProcessor)拼装进 Blob
 * (ADR-0001 语义不变,ADR-0003 双模式消费)。
 */
import { buildProcessorSource, createWorkletLoader } from '../workletLoader';
import resampleSource from './resample.dsp.js?raw';
import triodeSource from './triode.dsp.js?raw';
import ac30Source from './ac30Core.dsp.js?raw';

const processorSource = buildProcessorSource(
  [resampleSource, triodeSource, ac30Source],
  `
class WdfAc30Processor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'gain', defaultValue: 30, minValue: 0, maxValue: 100 },
      { name: 'bass', defaultValue: 50, minValue: 0, maxValue: 100 },
      { name: 'mid', defaultValue: 55, minValue: 0, maxValue: 100 },
      { name: 'treble', defaultValue: 60, minValue: 0, maxValue: 100 },
      { name: 'presence', defaultValue: 55, minValue: 0, maxValue: 100 },
    ];
  }

  constructor() {
    super();
    this.engine = new WdfAc30Engine(sampleRate);
  }

  process(inputs, outputs, params) {
    return this.engine.process(inputs, outputs, params);
  }
}

registerProcessor('wdf-ac30', WdfAc30Processor);
`,
);

/** 幂等加载(按 AudioContext 注册),使用前必须先 await */
export const loadAc30Wdf = createWorkletLoader(processorSource);
