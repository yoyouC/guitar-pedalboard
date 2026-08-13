/**
 * FET 压缩(1176 风格)的 AudioWorklet 处理器(Blob 内联,免构建配置)。
 *
 * 链路:输入 → 峰值检测 → dB 域增益计算机(4/8/12/20:1 / ALL 压限)
 *   → ATTACK(20~800µs)/RELEASE(50~1100ms) 包络 → 增益级
 *   → FET 输出级饱和(4x 过采样 + 48 阶 FIR 抗混叠)→ LEVEL → 输出。
 *   IIFE 隔离全局名;每通道独立链路状态。
 *
 * 增益计算/包络/饱和逻辑与 src/audio/wdf/fetComp.ts 一致——改动请两边同步。
 * 重采样 FIR 与 resample.ts 同一份(48 阶 Blackman-sinc)。
 */
import { createWorkletLoader } from '../workletLoader';

const processorSource = `(() => {
const OS = 4, NT = 48;
const LN10_OVER_20 = Math.log(10) / 20;
const DB_FLOOR = 1e-7;
const RATIO_STEPS = [4, 8, 12, 20, Infinity];

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function makeFIR() {
  const M = NT - 1;
  const fc = 0.09;
  const h = new Float32Array(NT);
  let sum = 0;
  for (let n = 0; n < NT; n++) {
    const x = n - M / 2;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / M) + 0.08 * Math.cos((4 * Math.PI * n) / M);
    h[n] = sinc * w;
    sum += h[n];
  }
  for (let n = 0; n < NT; n++) h[n] /= sum;
  return h;
}

class Up4 {
  constructor(h) {
    this.p = [];
    const mLen = NT / OS;
    for (let k = 0; k < OS; k++) {
      const pk = new Float32Array(mLen);
      for (let m = 0; m < mLen; m++) pk[m] = OS * h[k + OS * m];
      this.p.push(pk);
    }
    this.hist = new Float32Array(mLen);
    this.idx = 0;
  }
  process(out, xn) {
    this.idx = (this.idx - 1 + this.hist.length) % this.hist.length;
    this.hist[this.idx] = xn;
    for (let k = 0; k < OS; k++) {
      const pk = this.p[k];
      let acc = 0, j = this.idx;
      for (let m = 0; m < pk.length; m++) {
        acc += pk[m] * this.hist[j];
        j = (j + 1) % this.hist.length;
      }
      out[k] = acc;
    }
  }
}

class Down4 {
  constructor(h) {
    this.h = h;
    this.hist = new Float32Array(NT);
    this.idx = 0;
  }
  process(y0, y1, y2, y3) {
    const ys = [y0, y1, y2, y3];
    for (let k = 0; k < OS; k++) {
      this.idx = (this.idx - 1 + NT) % NT;
      this.hist[this.idx] = ys[k];
    }
    let acc = 0, j = this.idx;
    for (let m = 0; m < NT; m++) {
      acc += this.h[m] * this.hist[j];
      j = (j + 1) % this.hist.length;
    }
    return acc;
  }
}

class FetCompCore {
  constructor(fs) {
    this.fs = fs;
    this.thresholdDb = -20;
    this.slope = 1 - 1 / 8;
    this.attackCoef = 0;
    this.releaseCoef = 0;
    this.levelGain = 1;
    this.satK = 0.5;
    this.satBeta = 0.06;
    this.gr = 0;
    const fir = makeFIR();
    this.up = new Up4(fir);
    this.down = new Down4(fir);
    this.osBuf = new Float32Array(OS);
    this.setRatioIndex(1);
    this.setAttackUs(200);
    this.setReleaseMs(250);
  }
  setThresholdDb(v) {
    this.thresholdDb = clamp(v, -60, 0);
  }
  setRatioIndex(i) {
    const idx = clamp(Math.round(i), 0, RATIO_STEPS.length - 1);
    const R = RATIO_STEPS[idx];
    if (R === Infinity) {
      this.slope = 1;
      this.satK = 1.2;
      this.satBeta = 0.25;
    } else {
      this.slope = 1 - 1 / R;
      this.satK = 0.5;
      this.satBeta = 0.06;
    }
  }
  setAttackUs(us) {
    const tau = clamp(us, 20, 800) * 1e-6;
    this.attackCoef = 1 - Math.exp(-1 / (this.fs * tau));
  }
  setReleaseMs(ms) {
    const tau = clamp(ms, 50, 1100) * 1e-3;
    this.releaseCoef = 1 - Math.exp(-1 / (this.fs * tau));
  }
  setLevelGain(g) {
    this.levelGain = clamp(g, 0, 4);
  }
  sat(u) {
    return Math.tanh(this.satK * (u + this.satBeta * u * u)) / this.satK;
  }
  process(x) {
    const a = Math.abs(x);
    const levelDb = 20 * Math.log10(a < DB_FLOOR ? DB_FLOOR : a);
    const over = levelDb - this.thresholdDb;
    const target = over > 0 ? over * this.slope : 0;
    const coef = target > this.gr ? this.attackCoef : this.releaseCoef;
    this.gr += coef * (target - this.gr);
    const y = x * Math.exp(-this.gr * LN10_OVER_20);
    const drive = 1 + 0.4 * this.gr;
    this.up.process(this.osBuf, y);
    const s0 = this.sat(drive * this.osBuf[0]) / drive;
    const s1 = this.sat(drive * this.osBuf[1]) / drive;
    const s2 = this.sat(drive * this.osBuf[2]) / drive;
    const s3 = this.sat(drive * this.osBuf[3]) / drive;
    return this.down.process(s0, s1, s2, s3) * this.levelGain;
  }
}

class WdfFet1176Processor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -20, minValue: -60, maxValue: 0 },
      { name: 'ratio', defaultValue: 1, minValue: 0, maxValue: 4 },
      { name: 'attack', defaultValue: 200, minValue: 20, maxValue: 800 },
      { name: 'release', defaultValue: 250, minValue: 50, maxValue: 1100 },
      { name: 'level', defaultValue: 1, minValue: 0, maxValue: 2 },
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
    while (this.chains.length < input.length) this.chains.push(new FetCompCore(sampleRate));

    for (let ch = 0; ch < input.length; ch++) {
      const c = this.chains[ch];
      c.setThresholdDb(params.threshold[0]);
      c.setRatioIndex(params.ratio[0]);
      c.setAttackUs(params.attack[0]);
      c.setReleaseMs(params.release[0]);
      c.setLevelGain(params.level[0]);
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) out[i] = c.process(inp[i]);
    }
    return true;
  }
}

registerProcessor('wdf-fet1176', WdfFet1176Processor);
})();`;

/** 幂等加载(按 AudioContext 注册),使用前必须先 await */
export const loadFet1176 = createWorkletLoader(processorSource);
