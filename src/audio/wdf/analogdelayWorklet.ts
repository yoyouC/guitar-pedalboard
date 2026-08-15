/**
 * BBD 模拟延迟(Boss DM-2 / Memory Man 风格)的 AudioWorklet 处理器
 *(Blob 内联,免构建配置;每通道独立延迟线状态)。
 *
 * DSP 核见同目录 analogDelay.dsp.js(链路说明也在那里)——经 `?raw` 取源码
 * 字符串,与下方 wrapper(parameterDescriptors / Processor 子类 /
 * registerProcessor)拼装进 Blob(ADR-0001 语义不变,ADR-0003 双模式消费)。
 */
import { buildProcessorSource, createWorkletLoader } from '../workletLoader';
import analogDelaySource from './analogDelay.dsp.js?raw';

const processorSource = buildProcessorSource(
  [analogDelaySource],
  `
class BbdAnalogDelayProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'time', defaultValue: 300, minValue: 20, maxValue: 600, automationRate: 'k-rate' },
      { name: 'feedback', defaultValue: 40, minValue: 0, maxValue: 95, automationRate: 'k-rate' },
      { name: 'tone', defaultValue: 55, minValue: 0, maxValue: 100, automationRate: 'k-rate' },
      { name: 'mod', defaultValue: 0, minValue: 0, maxValue: 100, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 35, minValue: 0, maxValue: 100, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.engine = new BbdAnalogDelayEngine(sampleRate);
  }

  process(inputs, outputs, params) {
    return this.engine.process(inputs, outputs, params);
  }
}

registerProcessor('bbd-analog-delay', BbdAnalogDelayProcessor);
`,
);

/** 幂等加载(按 AudioContext 注册),使用前必须先 await */
export const loadAnalogDelayWdf = createWorkletLoader(processorSource);
