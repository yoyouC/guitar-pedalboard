/**
 * WDF Twin Reverb 实验箱头的 AudioWorklet 处理器(Blob 加载,免构建配置)。
 *
 * DSP 核见同目录 twinStages.dsp.js(链路说明与 TwinStage 变体的分叉原因
 * 也在那里)——经 `?raw` 取源码字符串,与下方 wrapper(parameterDescriptors /
 * Processor 子类 / registerProcessor)拼装进 Blob(ADR-0001 语义不变,
 * ADR-0003 双模式消费)。
 */
import { buildProcessorSource, createWorkletLoader } from '../workletLoader';
import resampleSource from './resample.dsp.js?raw';
import triodeSource from './triode.dsp.js?raw';
import twinSource from './twinStages.dsp.js?raw';

const processorSource = buildProcessorSource(
  [resampleSource, triodeSource, twinSource],
  `
class WdfTwinProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'gain', defaultValue: 40, minValue: 0, maxValue: 100 }];
  }

  constructor() {
    super();
    this.engine = new WdfTwinEngine(sampleRate);
  }

  process(inputs, outputs, params) {
    return this.engine.process(inputs, outputs, params);
  }
}

registerProcessor('wdf-twin', WdfTwinProcessor);
`,
);

/** 幂等加载(按 AudioContext 注册),使用前必须先 await */
export const loadTwinWdf = createWorkletLoader(processorSource);
