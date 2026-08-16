/**
 * 磁带延迟(Echoplex EP-3 风格)的 AudioWorklet 处理器(Blob 加载,免构建配置)。
 *
 * DSP 核见同目录 tapeDelay.dsp.js(链路说明也在那里)——经 `?raw` 取源码字符串,
 * 与下方 wrapper(parameterDescriptors / Processor 子类 / registerProcessor)
 * 拼装进 Blob(ADR-0001 语义不变,ADR-0003 双模式消费)。
 * 离线验证:scripts/wdf-tapedelay-eval.ts。
 */
import { buildProcessorSource, createWorkletLoader } from '../workletLoader';
import resampleSource from './resample.dsp.js?raw';
import tapeDelaySource from './tapeDelay.dsp.js?raw';

const processorSource = buildProcessorSource(
  [resampleSource, tapeDelaySource],
  `
class WdfTapeDelayProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'time', defaultValue: 400, minValue: 50, maxValue: 1000 },
      { name: 'feedback', defaultValue: 40, minValue: 0, maxValue: 110 },
      { name: 'wow', defaultValue: 30, minValue: 0, maxValue: 100 },
      { name: 'saturation', defaultValue: 40, minValue: 0, maxValue: 100 },
      { name: 'mix', defaultValue: 30, minValue: 0, maxValue: 100 },
    ];
  }

  constructor() {
    super();
    this.engine = new WdfTapeDelayEngine(sampleRate);
  }

  process(inputs, outputs, params) {
    return this.engine.process(inputs, outputs, params);
  }
}

registerProcessor('wdf-tapedelay', WdfTapeDelayProcessor);
`,
);

/** 幂等加载(按 AudioContext 注册),使用前必须先 await */
export const loadTapeDelayWdf = createWorkletLoader(processorSource);
