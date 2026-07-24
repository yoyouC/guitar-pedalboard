/**
 * WDF 版 Boss DS-1 的 AudioWorklet 处理器(Blob 内联,免构建配置)。
 *
 * 链路(ElectroSmash DS-1 元件值,全部在 4x 过采样域):
 *   输入 → 输入耦合 HP(C1 22n × R1 470k = 15.4Hz)
 *   → BJT 前级简化:固定增益 5 + Vsat=2V tanh 温和软削
 *   → 运放可变增益级(Z1 = R12 4.7k + C8 0.47u → 72Hz HP;反馈 Rf=2.2k+100k·DIST || C7 100p)
 *   → 1N4148 反并联对地削波(R17 2.2k,Rload 4.7k 为音色网络等效负载,每样本 Newton)
 *   → TONE:LP(723Hz,R19·C15)/ HP(7.2kHz,C14·R20)交叉淡化(中位中频凹陷)
 *   → LEVEL(线性,dB 域由外层转换)→ 输出
 *   内部 4x 过采样:多相升采样 + 48 阶 FIR 抗混叠降采样。IIFE 隔离全局名。
 *
 * 削波级求解逻辑与 src/audio/wdf/ds1Clipper.ts 一致——改动请两边同步。
 */
const processorSource = `(() => {
const DIODE = { Is: 2.52e-9, nVt: 1.752 * 25.85e-3 };
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

class Ds1ClipperStage {
  constructor(fs) {
    this.T = 1 / fs;
    this.R12 = 4.7e3;
    this.C8 = 0.47e-6;
    this.G7 = (2 * 100e-12) / this.T;
    this.Rf = 2.2e3 + 50e3;
    this.G17 = 1 / 2.2e3;
    this.Gload = 1 / 4.7e3;
    this.vc8 = 0;
    this.i1Prev = 0;
    this.ih7 = 0;
    this.vdPrev = 0;
  }

  setDist(d) {
    this.Rf = 2.2e3 + 100e3 * Math.min(1, Math.max(0, d));
  }

  process(vBst) {
    const a = this.T / (2 * this.C8);
    const i1 = (vBst - this.vc8 - a * this.i1Prev) / (this.R12 + a);
    this.vc8 += a * (i1 + this.i1Prev);
    this.i1Prev = i1;

    const gZf = 1 / this.Rf + this.G7;
    const vf = (i1 - this.ih7) / gZf;
    const iC7 = this.G7 * vf + this.ih7;
    this.ih7 = -this.G7 * vf - iC7;
    const vOp = vBst + vf;

    const { Is, nVt } = DIODE;
    const gSum = this.G17 + this.Gload;
    const src = vOp * this.G17;
    let vd = this.vdPrev;
    for (let iter = 0; iter < 12; iter++) {
      const f = 2 * Is * Math.sinh(vd / nVt) + vd * gSum - src;
      if (Math.abs(f) < 1e-12) break;
      const df = ((2 * Is) / nVt) * Math.cosh(vd / nVt) + gSum;
      let step = f / df;
      if (step > 0.2) step = 0.2;
      else if (step < -0.2) step = -0.2;
      vd -= step;
      if (vd > 1.0) vd = 1.0;
      else if (vd < -1.0) vd = -1.0;
    }
    this.vdPrev = vd;
    return vd;
  }
}

class WdfDs1Processor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'dist', defaultValue: 50, minValue: 0, maxValue: 100 },
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
    return {
      stage: new Ds1ClipperStage(fs),
      up: new Up4(this.fir),
      down: new Down4(this.fir),
      hpInY1: 0,   // 15.4Hz 输入耦合 HP 的低通状态
      toneLpY1: 0, // 723Hz LP 支路
      toneHpY1: 0, // 7.2kHz LP 状态(HP 支路 = x - LP)
      lastDist: -1,
    };
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    while (this.chains.length < input.length) this.chains.push(this.createChain());

    const T = 1 / (sampleRate * OS);
    const aHpIn = T / (470e3 * 0.022e-6 + T);   // C1·R1 → 15.4Hz
    const aToneLp = T / (2.2e3 * 0.1e-6 + T);   // R19·C15 → 723Hz LP
    const aToneHp = T / (2.2e3 * 0.01e-6 + T);  // C14·R20 → 7.2kHz HP(经 x - LP 实现)
    // tone 0~100 → LP/HP 交叉淡化比(0= LP 暗,1= HP 亮,中位中频凹陷)
    const t = params.tone[0] / 100;
    const level = params.level[0];
    const dist = params.dist[0] / 100;
    const osIn = new Float32Array(OS);
    const osOut = new Float32Array(OS);

    for (let ch = 0; ch < input.length; ch++) {
      const c = this.chains[ch];
      if (c.lastDist !== dist) {
        c.stage.setDist(dist);
        c.lastDist = dist;
      }
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) {
        c.up.process(osIn, inp[i]);
        for (let k = 0; k < OS; k++) {
          // 输入耦合 HP(x - LP)
          c.hpInY1 += aHpIn * (osIn[k] - c.hpInY1);
          const hp = osIn[k] - c.hpInY1;
          // BJT 前级简化:固定增益 5 + Vsat=2V tanh 温和软削
          const bst = 2.0 * Math.tanh(2.5 * hp);
          // 运放可变增益 + 对地二极管削波
          const s = c.stage.process(bst);
          // TONE 交叉淡化:LP(723Hz) 与 HP(7.2kHz)
          c.toneLpY1 += aToneLp * (s - c.toneLpY1);
          c.toneHpY1 += aToneHp * (s - c.toneHpY1);
          osOut[k] = (1 - t) * c.toneLpY1 + t * (s - c.toneHpY1);
        }
        out[i] = c.down.process(osOut[0], osOut[1], osOut[2], osOut[3]) * level;
      }
    }
    return true;
  }
}

registerProcessor('wdf-ds1', WdfDs1Processor);
})();`;

let loaded = false;

/** 幂等加载,使用前必须先 await */
export async function loadDs1Wdf(ctx: AudioContext): Promise<void> {
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
