/**
 * WDF 版 Big Muff Pi 的 AudioWorklet 处理器(Blob 内联,免构建配置)。
 *
 * 链路(逻辑与 src/audio/wdf/bigmuff.ts 一致——改动请两边同步):
 *   输入 → SUSTAIN 分压 → 90Hz HP → 削波级1(理想反相增益 16 + Rth 6.9k
 *   + 反并联 1N4148 对地)→ 155Hz HP → 920Hz LP(级2 Miller 加载极点)
 *   → 削波级2(增益 42 + Rth 9.8k + 二极管对)→ 3.2Hz HP
 *   → TONE 交叉淡化(LP 39k/10n + HP 4n/22k,100k 滑点混合,3×3 精确离散)
 *   → LEVEL(线性,dB 域由外层转换)→ 输出
 *   内部 4x 过采样:多相升采样 + 48 阶 FIR 抗混叠降采样。IIFE 隔离全局名。
 */
const processorSource = `(() => {
const DIODE = { Is: 2.52e-9, nVt: 1.752 * 25.85e-3 };
const MUFF = {
  A1: 16, RTH1: 6.9e3, A2: 42, RTH2: 9.8e3,
  FC_HP_IN: 90, FC_HP_MID: 155, FC_LP_MID: 920, FC_HP_OUT: 3.2,
  TONE_RSRC: 10e3, TONE_R_LP: 39e3, TONE_C_LP: 10e-9,
  TONE_C_HP: 4e-9, TONE_R_HP: 22e3, TONE_POT: 100e3,
};
const OS = 4, NT = 48;

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

class OnePoleHP {
  constructor(fs, fc) {
    const K = 2 * fs;
    const w = 2 * Math.PI * fc;
    this.b0 = K / (K + w);
    this.a1 = (K - w) / (K + w);
    this.x1 = 0;
    this.y1 = 0;
  }
  process(x) {
    const y = this.a1 * this.y1 + this.b0 * (x - this.x1);
    this.x1 = x;
    this.y1 = y;
    return y;
  }
}

class OnePoleLP {
  constructor(fs, fc) {
    const K = 2 * fs;
    const w = 2 * Math.PI * fc;
    this.b0 = w / (K + w);
    this.a1 = (K - w) / (K + w);
    this.x1 = 0;
    this.y1 = 0;
  }
  process(x) {
    const y = this.a1 * this.y1 + this.b0 * (x + this.x1);
    this.x1 = x;
    this.y1 = y;
    return y;
  }
}

class MuffClipStage {
  constructor(A, Rth) {
    this.A = A;
    this.gTh = 1 / Rth;
    this.vcPrev = 0;
  }
  process(vs) {
    const vth = -this.A * vs;
    const { Is, nVt } = DIODE;
    let vc = this.vcPrev;
    for (let iter = 0; iter < 12; iter++) {
      const f = 2 * Is * Math.sinh(vc / nVt) + (vc - vth) * this.gTh;
      if (Math.abs(f) < 1e-12) break;
      const df = ((2 * Is) / nVt) * Math.cosh(vc / nVt) + this.gTh;
      let step = f / df;
      if (step > 0.2) step = 0.2;
      else if (step < -0.2) step = -0.2;
      vc -= step;
      if (vc > 1.0) vc = 1.0;
      else if (vc < -1.0) vc = -1.0;
    }
    this.vcPrev = vc;
    return vc;
  }
}

class MuffTone {
  constructor(fs) {
    const T = 1 / fs;
    const M = MUFF;
    this.gC8 = (2 * M.TONE_C_LP) / T;
    this.gC9 = (2 * M.TONE_C_HP) / T;
    this.ih8 = 0;
    this.ih9 = 0;
    this.t = 0.5;
    const gSrc = 1 / M.TONE_RSRC;
    const gR8 = 1 / M.TONE_R_LP;
    const gR5 = 1 / M.TONE_R_HP;
    const gP = 1 / M.TONE_POT;
    const a = gSrc + gR8 + this.gC9, b = -gR8, c = -this.gC9;
    const d = -gR8, e = gR8 + this.gC8 + gP, f = -gP;
    const g = -this.gC9, h = -gP, i = this.gC9 + gR5 + gP;
    const Ai = e * i - f * h;
    const Bi = c * h - b * i;
    const Ci = b * f - c * e;
    const det = a * Ai + d * Bi + g * Ci;
    this.inv = [
      Ai / det, Bi / det, Ci / det,
      (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
      (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
    ];
  }
  setTone(t) {
    this.t = Math.min(1, Math.max(0, t));
  }
  process(vh) {
    const inv = this.inv;
    const r0 = vh / MUFF.TONE_RSRC - this.ih9;
    const r1 = -this.ih8;
    const r2 = this.ih9;
    const vs = inv[0] * r0 + inv[1] * r1 + inv[2] * r2;
    const vA = inv[3] * r0 + inv[4] * r1 + inv[5] * r2;
    const vB = inv[6] * r0 + inv[7] * r1 + inv[8] * r2;
    const i8 = this.gC8 * vA + this.ih8;
    this.ih8 = -this.gC8 * vA - i8;
    const dv9 = vs - vB;
    const i9 = this.gC9 * dv9 + this.ih9;
    this.ih9 = -this.gC9 * dv9 - i9;
    return (1 - this.t) * vA + this.t * vB;
  }
}

class WdfBigMuffProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'sustain', defaultValue: 50, minValue: 0, maxValue: 100 },
      { name: 'tone', defaultValue: 50, minValue: 0, maxValue: 100 },
      { name: 'level', defaultValue: 1, minValue: 0, maxValue: 2 },
    ];
  }

  constructor() {
    super();
    this.fir = makeFIR();
    this.chains = [];
  }

  createChain() {
    const fs = sampleRate * OS;
    const M = MUFF;
    return {
      up: new Up4(this.fir),
      down: new Down4(this.fir),
      hpIn: new OnePoleHP(fs, M.FC_HP_IN),
      stage1: new MuffClipStage(M.A1, M.RTH1),
      hpMid: new OnePoleHP(fs, M.FC_HP_MID),
      lpMid: new OnePoleLP(fs, M.FC_LP_MID),
      stage2: new MuffClipStage(M.A2, M.RTH2),
      hpOut: new OnePoleHP(fs, M.FC_HP_OUT),
      tone: new MuffTone(fs),
    };
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    while (this.chains.length < input.length) this.chains.push(this.createChain());

    const sustain = params.sustain[0] / 100;
    const toneT = params.tone[0] / 100;
    const level = params.level[0];
    const osIn = new Float32Array(OS);
    const osOut = [0, 0, 0, 0];

    for (let ch = 0; ch < input.length; ch++) {
      const c = this.chains[ch];
      c.tone.setTone(toneT);
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) {
        c.up.process(osIn, inp[i]);
        for (let k = 0; k < OS; k++) {
          const u1 = c.hpIn.process(sustain * osIn[k]);
          const c1 = c.stage1.process(u1);
          const u2 = c.lpMid.process(c.hpMid.process(c1));
          const c2 = c.stage2.process(u2);
          osOut[k] = c.tone.process(c.hpOut.process(c2));
        }
        out[i] = c.down.process(osOut[0], osOut[1], osOut[2], osOut[3]) * level;
      }
    }
    return true;
  }
}

registerProcessor('wdf-bigmuff', WdfBigMuffProcessor);
})();`;

let loaded = false;

/** 幂等加载,使用前必须先 await */
export async function loadBigMuffWdf(ctx: AudioContext): Promise<void> {
  if (loaded) return;
  const url = URL.createObjectURL(
    new Blob([processorSource], { type: 'application/javascript' }),
  );
  try {
    await ctx.audioWorklet.addModule(url);
    loaded = true;
  } finally {
    URL.revokeObjectURL(url);
  }
}
