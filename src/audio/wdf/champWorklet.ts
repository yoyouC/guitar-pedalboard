/**
 * WDF Champ 实验箱头的 AudioWorklet 处理器(Blob 加载,免构建配置)。
 *
 * DSP 核见同目录 champ.dsp.js(链路说明也在那里)——经 `?raw` 取源码字符串,
 * 与下方 wrapper(parameterDescriptors / Processor 子类 / registerProcessor)
 * 拼装进 Blob(ADR-0001 语义不变,ADR-0003 双模式消费)。
 */
import { buildProcessorSource, createWorkletLoader } from '../workletLoader';
import resampleSource from './resample.dsp.js?raw';
import triodeSource from './triode.dsp.js?raw';
import champSource from './champ.dsp.js?raw';

const processorSource = buildProcessorSource(
  [resampleSource, triodeSource, champSource],
  `
class WdfChampProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'gain', defaultValue: 50, minValue: 0, maxValue: 100 },
      // 线性增益(dB 域由外层转换),默认 -6dB ≈ 0.5
      { name: 'master', defaultValue: 0.5, minValue: 0, maxValue: 2 },
    ];
  }

  constructor() {
    super();
    this.engine = new WdfChampEngine(sampleRate);
  }

  process(inputs, outputs, params) {
    return this.engine.process(inputs, outputs, params);
  }
}

registerProcessor('wdf-champ', WdfChampProcessor);
`,
);

/** 幂等加载(按 AudioContext 注册),使用前必须先 await */
export const loadChampWdf = createWorkletLoader(processorSource);
