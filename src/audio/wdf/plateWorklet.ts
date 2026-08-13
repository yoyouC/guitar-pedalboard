/**
 * 板式混响(Plate Reverb,EMT-140 风格)的 AudioWorklet 处理器(Blob 内联,免构建配置)。
 *
 * 链路:输入 → PREDELAY(0~100ms,分数延迟 + 位置平滑)→ 4 级输入扩散全通(k=0.6)
 *   → 反馈环(AP1→AP2→D1→阻尼低通(DAMP)→√G→AP3→AP4→D2→√G→回注)
 *   → 12 抽头湿声 → MIX 等功率交叉 → 输出。
 *   纯线性 FDN,无需过采样;每通道独立链,variant = ch%2 两组互质长度 → 立体声去相关。
 *   IIFE 隔离全局名。
 *
 * DSP 逻辑与 src/audio/wdf/plateReverb.ts 一致——改动请两边同步。
 */
import { createWorkletLoader } from '../workletLoader';

const processorSource = `(() => {
const K_INPUT = 0.6;
const K_LOOP = 0.6;
const MAX_PREDELAY_MS = 100;
const DAMP_COEF_MAX = 0.65;
const WET_NORM = 0.25;
const BASE_FS = 48000;
const INPUT_AP_LEN = [160, 121, 428, 313];
const LOOP_LEN = [
  { ap: [293, 461, 631, 797], d: [7183, 6001] },
  { ap: [389, 557, 701, 863], d: [6803, 5101] },
];
const TAPS1 = [0.06, 0.19, 0.37, 0.52, 0.74, 0.91];
const TAPS2 = [0.11, 0.26, 0.43, 0.59, 0.79, 0.93];

class Allpass {
  constructor(len, k) {
    this.len = len;
    this.k = k;
    this.buf = new Float32Array(len);
    this.pos = 0;
  }
  process(x) {
    const b = this.buf[this.pos];
    const y = b - this.k * x;
    this.buf[this.pos] = x + this.k * y;
    this.pos = this.pos + 1 === this.len ? 0 : this.pos + 1;
    return y;
  }
}

class TapDelay {
  constructor(len) {
    this.len = len;
    this.buf = new Float32Array(len);
    this.head = 0;
  }
  process(x) {
    const i = this.head % this.len;
    const y = this.buf[i];
    this.buf[i] = x;
    this.head++;
    return y;
  }
  tap(m) {
    let i = (this.head - m) % this.len;
    if (i < 0) i += this.len;
    return this.buf[i];
  }
}

class PreDelay {
  constructor(fs, maxMs) {
    this.fs = fs;
    this.buf = new Float32Array(Math.ceil((fs * maxMs) / 1000) + 2);
    this.kPos = 1 - Math.exp(-1 / (0.01 * fs));
    this.head = 0;
    this.pos = 0;
    this.target = 0;
  }
  setMs(ms) {
    const c = Math.min(MAX_PREDELAY_MS, Math.max(0, ms));
    this.target = Math.min((c * this.fs) / 1000, this.buf.length - 2);
  }
  process(x) {
    const len = this.buf.length;
    this.buf[this.head % len] = x;
    this.head++;
    this.pos += this.kPos * (this.target - this.pos);
    const m = this.pos > len - 2 ? len - 2 : this.pos;
    const m0 = Math.floor(m);
    const f = m - m0;
    let ia = (this.head - 1 - m0) % len;
    if (ia < 0) ia += len;
    let ib = ia - 1;
    if (ib < 0) ib += len;
    const a = this.buf[ia];
    return a + f * (this.buf[ib] - a);
  }
}

class PlateReverbCore {
  constructor(fs, variant) {
    this.fs = fs;
    const s = fs / BASE_FS;
    const len = (base) => Math.max(4, Math.round(base * s));
    this.pre = new PreDelay(fs, MAX_PREDELAY_MS);
    this.apIn = INPUT_AP_LEN.map((L) => new Allpass(len(L), K_INPUT));
    const table = LOOP_LEN[variant];
    this.ap1 = new Allpass(len(table.ap[0]), K_LOOP);
    this.ap2 = new Allpass(len(table.ap[1]), K_LOOP);
    this.ap3 = new Allpass(len(table.ap[2]), K_LOOP);
    this.ap4 = new Allpass(len(table.ap[3]), K_LOOP);
    this.d1 = new TapDelay(len(table.d[0]));
    this.d2 = new TapDelay(len(table.d[1]));
    const offs = (fracs, L) => fracs.map((f) => Math.min(L - 1, Math.max(1, Math.round(f * L))));
    this.taps1 = offs(TAPS1, this.d1.len);
    this.taps2 = offs(TAPS2, this.d2.len);
    this.loopSamples =
      this.ap1.len + this.ap2.len + this.ap3.len + this.ap4.len + this.d1.len + this.d2.len;
    this.dampS = 0;
    this.fb = 0;
    this.g = 0;
    this.dampCoef = 0;
    this.dry = Math.SQRT1_2;
    this.wet = Math.SQRT1_2;
    this.timeS = 0;
    this.damp01 = -1;
    this.mix01 = -1;
    this.setTime(2.5);
    this.setDamp(0.4);
    this.setPreDelayMs(0);
    this.setMix(0.3);
  }
  setTime(t) {
    const tc = Math.min(6, Math.max(0.5, t));
    if (tc === this.timeS) return;
    this.timeS = tc;
    const tLoop = this.loopSamples / this.fs;
    const gTrip = Math.pow(10, (-3 * tLoop) / tc);
    this.g = Math.sqrt(gTrip);
  }
  setDamp(d) {
    const dc = Math.min(1, Math.max(0, d));
    if (dc === this.damp01) return;
    this.damp01 = dc;
    this.dampCoef = DAMP_COEF_MAX * dc;
  }
  setPreDelayMs(ms) {
    this.pre.setMs(ms);
  }
  setMix(m) {
    const mc = Math.min(1, Math.max(0, m));
    if (mc === this.mix01) return;
    this.mix01 = mc;
    this.dry = Math.cos((mc * Math.PI) / 2);
    this.wet = Math.sin((mc * Math.PI) / 2);
  }
  process(x) {
    let s = this.pre.process(x);
    for (let i = 0; i < this.apIn.length; i++) s = this.apIn[i].process(s);
    const u = s + this.fb;
    const a = this.ap2.process(this.ap1.process(u));
    const d1o = this.d1.process(a);
    this.dampS = (1 - this.dampCoef) * d1o + this.dampCoef * this.dampS;
    const b = this.ap4.process(this.ap3.process(this.g * this.dampS));
    const d2o = this.d2.process(b);
    this.fb = this.g * d2o;
    let w = 0;
    for (let i = 0; i < this.taps1.length; i++)
      w += (i % 2 === 0 ? 1 : -1) * this.d1.tap(this.taps1[i]);
    for (let i = 0; i < this.taps2.length; i++)
      w += (i % 2 === 0 ? -1 : 1) * this.d2.tap(this.taps2[i]);
    return this.dry * x + this.wet * (WET_NORM * w);
  }
}

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
    this.chains = [];
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    while (this.chains.length < input.length)
      this.chains.push(new PlateReverbCore(sampleRate, this.chains.length % 2));

    const time = params.time[0];
    const damp = params.damp[0] / 100;
    const preDelay = params.preDelay[0];
    const mix = params.mix[0] / 100;

    for (let ch = 0; ch < input.length; ch++) {
      const c = this.chains[ch];
      c.setTime(time);
      c.setDamp(damp);
      c.setPreDelayMs(preDelay);
      c.setMix(mix);
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) out[i] = c.process(inp[i]);
    }
    return true;
  }
}

registerProcessor('plate-reverb', PlateReverbProcessor);
})();`;

/** 幂等加载(按 AudioContext 注册),使用前必须先 await */
export const loadPlateReverb = createWorkletLoader(processorSource);
