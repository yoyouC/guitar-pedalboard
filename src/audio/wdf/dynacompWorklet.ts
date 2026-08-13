/**
 * Dyna Comp 风格 OTA 压缩的 AudioWorklet 处理器(Blob 内联,免构建配置)。
 *
 * 链路:输入 → DynaCompCore(OTA VCA + 反馈峰值包络侧链,kFb=10 → 11:1,
 *   固定快启动 2ms / 释放 250ms,SENSITIVITY 反比调阈值)→ LEVEL(线性,dB 域由外层转换)→ 输出。
 * 时序类线性时变系统,无削波非线性,故不过采样,直接 sampleRate。
 * IIFE 隔离全局名;每通道独立压缩链(独立包络/增益状态,防立体声串扰)。
 *
 * 压缩 DSP 逻辑与 src/audio/wdf/dynaComp.ts 一致——改动请两边同步。
 */
import { createWorkletLoader } from '../workletLoader';

const processorSource = `(() => {
const THR_MAX_DB = -10;
const THR_SPAN_DB = 45;
const ENV_FLOOR = 1e-7;

class DynaCompCore {
  constructor(fs) {
    this.cAtt = 1 - Math.exp(-1 / (0.002 * fs)); // 启动 2ms
    this.cRel = 1 - Math.exp(-1 / (0.250 * fs)); // 释放 250ms
    this.kFb = 10;                               // 静态压缩比 1+kFb = 11:1
    this.thrDb = THR_MAX_DB - THR_SPAN_DB * 0.5;
    this.grDb = 0;
    this.gain = 1;
  }

  setSensitivity(s) {
    const sc = Math.min(1, Math.max(0, s));
    this.thrDb = THR_MAX_DB - THR_SPAN_DB * sc;
  }

  process(x) {
    const y = this.gain * x;
    const inst = Math.abs(y);
    const envDb = 20 * Math.log10(inst > ENV_FLOOR ? inst : ENV_FLOOR);
    const over = envDb - this.thrDb;
    const target = over > 0 ? this.kFb * over : 0;
    const c = target > this.grDb ? this.cAtt : this.cRel;
    this.grDb += c * (target - this.grDb);
    if (this.grDb < 1e-9 && target === 0) this.grDb = 0;
    this.gain = Math.pow(10, -this.grDb / 20);
    return y;
  }
}

class WdfDynaCompProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'sensitivity', defaultValue: 50, minValue: 0, maxValue: 100 },
      { name: 'level', defaultValue: 1, minValue: 0, maxValue: 2 },
    ];
  }

  constructor() {
    super();
    this.chains = [];
  }

  createChain() {
    return { core: new DynaCompCore(sampleRate), lastSens: -1 };
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    while (this.chains.length < input.length) this.chains.push(this.createChain());

    const sens = params.sensitivity[0] / 100;
    const level = params.level[0];

    for (let ch = 0; ch < input.length; ch++) {
      const c = this.chains[ch];
      if (c.lastSens !== sens) {
        c.core.setSensitivity(sens);
        c.lastSens = sens;
      }
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) {
        out[i] = c.core.process(inp[i]) * level;
      }
    }
    return true;
  }
}

registerProcessor('wdf-dynacomp', WdfDynaCompProcessor);
})();`;

/** 幂等加载(按 AudioContext 注册),使用前必须先 await */
export const loadDynaCompWdf = createWorkletLoader(processorSource);
