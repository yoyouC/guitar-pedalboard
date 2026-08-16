/**
 * WDF 版 Crybaby GCB-95 的 AudioWorklet 处理器(Blob 装配,免构建配置)。
 *
 * DSP 核见同目录 crybabyStage.dsp.js(链路说明也在那里)——经 `?raw` 取源码
 * 字符串,与下方 wrapper(parameterDescriptors / Processor 子类 /
 * registerProcessor)拼装进 Blob(ADR-0001 语义不变,ADR-0003 双模式消费)。
 * position 为 a-rate(摇杆连续扫频),引擎内逐样本更新电位器两片电阻。
 * suspend/port 消息为 AudioWorklet 特有逻辑,留在下方 wrapper。
 */
import { buildProcessorSource, createWorkletLoader } from '../workletLoader';
import resampleSource from './resample.dsp.js?raw';
import crybabySource from './crybabyStage.dsp.js?raw';

const processorSource = buildProcessorSource(
  [resampleSource, crybabySource],
  `
class WdfCrybabyProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'position', defaultValue: 50, minValue: 0, maxValue: 100, automationRate: 'a-rate' },
      { name: 'level', defaultValue: 1, minValue: 0, maxValue: 2 },
    ];
  }

  constructor() {
    super();
    this.engine = new WdfCrybabyEngine(sampleRate);
    this.suspended = false;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'suspend') this.suspended = true;
    };
  }

  process(inputs, outputs, params) {
    // 已废弃(宿主实例 dispose):返回 false 停止渲染,避免僵尸节点空转
    if (this.suspended) return false;
    return this.engine.process(inputs, outputs, params);
  }
}

registerProcessor('wdf-crybaby', WdfCrybabyProcessor);
`,
);

/** 幂等加载(按 AudioContext 注册),使用前必须先 await */
export const loadCrybabyWdf = createWorkletLoader(processorSource);
