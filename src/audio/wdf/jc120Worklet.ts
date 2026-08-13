/**
 * WDF JC-120(Roland Jazz Chorus 风格,全固态极致清音)AudioWorklet 处理器。
 * Blob 内联,免构建配置。
 *
 * 链路:
 *   输入 → 4x 多相升采样 → [30Hz HP → 运放增益级(15V 轨 tanh 软饱和)
 *   → 固态后级 ×2(25V 深度 tanh 兜底)→ 扬声器 50Hz HP + 8kHz LP → /12]
 *   → 48 阶 FIR 降采样 → 可选 CHORUS(0.45Hz 三角 LFO,5ms±2.5ms,50/50 混合,
 *   立体声 LFO 相位错开)→ 输出
 *   MASTER 与三段音色栈在 AmpDef 侧用原生节点。
 *
 * 核心逻辑与 src/audio/wdf/jc120Core.ts 一致——改动请两边同步。
 * 全链非线性为显式无记忆 tanh(串联无反馈),无需 Newton。
 */
import { createWorkletLoader } from '../workletLoader';

const processorSource = `
(() => {
const OS = 4, NT = 48;
const HP_IN = 30, RAIL_PRE = 15, PRE_MIN = 2, PRE_SPAN = 18;
const POWER_GAIN = 2, RAIL_POWER = 25, SPK_HP = 50, SPK_LP = 8000, NORM = 12;
const CH_RATE = 0.45, CH_CENTER_MS = 5, CH_DEPTH_MS = 2.5, CH_MIX = 0.5;

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
      j = (j + 1) % NT;
    }
    return acc;
  }
}

class Jc120Core {
  constructor(fs) {
    this.T = 1 / fs;
    this.drive = PRE_MIN + 0.4 * PRE_SPAN;
    // 单极点 HP 状态:a = rc/(rc+T)
    const rcIn = 1 / (2 * Math.PI * HP_IN);
    this.aHpIn = rcIn / (rcIn + this.T);
    this.inX1 = 0; this.inY1 = 0;
    const rcSpk = 1 / (2 * Math.PI * SPK_HP);
    this.aSpkHp = rcSpk / (rcSpk + this.T);
    this.spX1 = 0; this.spY1 = 0;
    // 单极点 LP:a = T/(rc+T)
    const rcLp = 1 / (2 * Math.PI * SPK_LP);
    this.aSpkLp = this.T / (rcLp + this.T);
    this.lpY1 = 0;
  }
  setGain(gainPct) {
    this.drive = PRE_MIN + (gainPct / 100) * PRE_SPAN;
  }
  processOs(x) {
    // 输入耦合 HP 30Hz
    let y = this.aHpIn * (this.inY1 + x - this.inX1);
    this.inX1 = x;
    this.inY1 = y;
    // 运放线性增益级 + 15V 轨软饱和
    const v1 = RAIL_PRE * Math.tanh((y * this.drive) / RAIL_PRE);
    // 固态后级 ×2 + 25V 深度 tanh 兜底
    const v2 = RAIL_POWER * Math.tanh((POWER_GAIN * v1) / RAIL_POWER);
    // 扬声器 50Hz HP
    y = this.aSpkHp * (this.spY1 + v2 - this.spX1);
    this.spX1 = v2;
    this.spY1 = y;
    // 扬声器 8kHz LP
    this.lpY1 = this.lpY1 + this.aSpkLp * (y - this.lpY1);
    return this.lpY1 / NORM;
  }
}

class Jc120Chorus {
  constructor(fs, phase0) {
    this.fs = fs;
    let len = 1;
    while (len < fs * 0.02) len <<= 1;
    this.buf = new Float32Array(len);
    this.mask = len - 1;
    this.w = 0;
    this.phase = phase0 - Math.floor(phase0);
    this.target = 0;
    this.mix = 0;
  }
  setOn(on) {
    this.target = on > 0.5 ? CH_MIX : 0;
  }
  process(x) {
    if (this.mix < 1e-6 && this.target === 0) {
      this.w = (this.w + 1) & this.mask;
      this.buf[this.w] = x;
      this.phase += CH_RATE / this.fs;
      if (this.phase >= 1) this.phase -= 1;
      return x;
    }
    this.w = (this.w + 1) & this.mask;
    this.buf[this.w] = x;
    const tri = this.phase < 0.5 ? 4 * this.phase - 1 : 3 - 4 * this.phase;
    const d = ((CH_CENTER_MS + CH_DEPTH_MS * tri) / 1000) * this.fs;
    const r = this.w - d;
    const i0 = Math.floor(r);
    const frac = r - i0;
    const a = this.buf[i0 & this.mask];
    const wet = a + (this.buf[(i0 + 1) & this.mask] - a) * frac;
    this.phase += CH_RATE / this.fs;
    if (this.phase >= 1) this.phase -= 1;
    this.mix += 0.002 * (this.target - this.mix);
    return x * (1 - this.mix) + wet * this.mix;
  }
}

class WdfJc120Processor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'gain', defaultValue: 40, minValue: 0, maxValue: 100 },
      { name: 'chorus', defaultValue: 0, minValue: 0, maxValue: 1 },
    ];
  }

  constructor() {
    super();
    this.fir = makeFIR();
    this.chains = [];
  }

  createChain(chIndex) {
    const fsOs = sampleRate * OS;
    return {
      core: new Jc120Core(fsOs),
      // 立体声合唱:LFO 相位按通道错开 1/4 周期(右声道正交)
      chorus: new Jc120Chorus(sampleRate, chIndex * 0.25),
      up: new Up4(this.fir),
      down: new Down4(this.fir),
    };
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    while (this.chains.length < input.length) {
      this.chains.push(this.createChain(this.chains.length));
    }
    const gain = params.gain[0];
    const chorusOn = params.chorus[0];
    const osIn = new Float32Array(OS);
    const osOut = new Float32Array(OS);
    for (let ch = 0; ch < input.length; ch++) {
      const c = this.chains[ch];
      c.core.setGain(gain);
      c.chorus.setOn(chorusOn);
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) {
        c.up.process(osIn, inp[i]);
        for (let k = 0; k < OS; k++) osOut[k] = c.core.processOs(osIn[k]);
        out[i] = c.chorus.process(c.down.process(osOut[0], osOut[1], osOut[2], osOut[3]));
      }
    }
    return true;
  }
}

registerProcessor('wdf-jc120', WdfJc120Processor);
})();
`;

/** 幂等加载(按 AudioContext 注册),使用前必须先 await */
export const loadJc120Wdf = createWorkletLoader(processorSource);
