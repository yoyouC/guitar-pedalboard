/**
 * LA-2A 风格光学压缩的 AudioWorklet 处理器(Blob 内联,免构建配置)。
 *
 * 链路:输入 → 侧链(峰值检测 → 软拐点静态 GR → T4B 双支路包络 fast/slow)
 *   → 增益级(10^(-grDb/20))→ GAIN 补偿(线性,dB 域由外层转换)→ 输出。
 *   增益调制为慢变包络(带宽 ≪ fs/2),无削波非线性,不需要过采样。
 *   IIFE 隔离全局名;每通道独立 T4B 包络状态。
 *
 * DSP 逻辑与 src/audio/wdf/la2aOpto.ts 一致——改动请两边同步。
 */
import { createWorkletLoader } from '../workletLoader';

const processorSource = `(() => {
const ENV_REL_S = 0.005;
const ATK_FAST_S = 0.01;
const REL_FAST_S = 0.06;
const ATK_SLOW_S = 0.25;
const REL_SLOW_S = 1.3;
const SLOW_DEPTH = 0.5;
const KNEE_DB = 15;
const RATIO_COMPRESS = 3;
const RATIO_LIMIT = 10;
const ENV_FLOOR = 1e-9;
const LN10_OVER_20 = Math.log(10) / 20;

class La2aOptoComp {
  constructor(fs) {
    this.coefEnvRel = Math.exp(-1 / (ENV_REL_S * fs));
    this.coefAtkFast = 1 - Math.exp(-1 / (ATK_FAST_S * fs));
    this.coefRelFast = 1 - Math.exp(-1 / (REL_FAST_S * fs));
    this.coefAtkSlow = 1 - Math.exp(-1 / (ATK_SLOW_S * fs));
    this.coefRelSlow = 1 - Math.exp(-1 / (REL_SLOW_S * fs));
    this.thresholdDb = 2 - 0.42 * 30;
    this.ratio = RATIO_COMPRESS;
    this.makeup = 1;
    this.envLin = 0;
    this.fastDb = 0;
    this.slowDb = 0;
    this.grDb = 0;
  }
  setReduction(r) {
    const rc = Math.min(100, Math.max(0, r));
    this.thresholdDb = 2 - 0.42 * rc;
  }
  setMode(mode) {
    this.ratio = mode >= 0.5 ? RATIO_LIMIT : RATIO_COMPRESS;
  }
  setMakeupGain(lin) {
    this.makeup = Math.min(40, Math.max(0, lin));
  }
  staticGrDb(envDb) {
    const over = envDb - this.thresholdDb;
    const slope = 1 - 1 / this.ratio;
    const halfK = KNEE_DB / 2;
    if (over <= -halfK) return 0;
    if (over >= halfK) return slope * over;
    const t = over + halfK;
    return (slope * t * t) / (2 * KNEE_DB);
  }
  process(x) {
    const ax = Math.abs(x);
    this.envLin = ax > this.envLin ? ax : this.envLin * this.coefEnvRel;
    const envDb = Math.log(this.envLin + ENV_FLOOR) / LN10_OVER_20;
    const gr = this.staticGrDb(envDb);
    const cF = gr > this.fastDb ? this.coefAtkFast : this.coefRelFast;
    this.fastDb += cF * (gr - this.fastDb);
    const sTarget = SLOW_DEPTH * gr;
    const cS = sTarget > this.slowDb ? this.coefAtkSlow : this.coefRelSlow;
    this.slowDb += cS * (sTarget - this.slowDb);
    this.grDb = Math.max(this.fastDb, this.slowDb);
    return x * Math.exp(-this.grDb * LN10_OVER_20) * this.makeup;
  }
}

class La2aOptoProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'reduction', defaultValue: 30, minValue: 0, maxValue: 100 },
      { name: 'gain', defaultValue: 1, minValue: 0, maxValue: 40 },
      { name: 'mode', defaultValue: 0, minValue: 0, maxValue: 1 },
    ];
  }

  constructor() {
    super();
    this.chains = [];
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    while (this.chains.length < input.length) this.chains.push(new La2aOptoComp(sampleRate));

    const reduction = params.reduction[0];
    const gain = params.gain[0];
    const mode = params.mode[0];

    for (let ch = 0; ch < input.length; ch++) {
      const c = this.chains[ch];
      c.setReduction(reduction);
      c.setMakeupGain(gain);
      c.setMode(mode);
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) out[i] = c.process(inp[i]);
    }
    return true;
  }
}

registerProcessor('opto-la2a', La2aOptoProcessor);
})();`;

/** 幂等加载(按 AudioContext 注册),使用前必须先 await */
export const loadLa2aOpto = createWorkletLoader(processorSource);
