/**
 * WDF Champ 实验箱头的 AudioWorklet 处理器(Blob 内联,免构建配置)。
 *
 * 链路(5F1 Champ 风格):
 *   输入 → drive(GAIN)→ 12AX7 级 1(Rk820 无旁路,冷偏置 bright)
 *   → 级间衰减 → 12AX7 级 2(全旁路)
 *   → 6V6 单端后级(近似 Koren 功率管)→ 输出变压器(80Hz HP + 6.5kHz LP)
 *   → MASTER → 输出
 *   内部 4x 过采样:多相升采样 + 31 阶 Blackman-sinc FIR 抗混叠降采样
 *   (与 src/audio/wdf/resample.ts 同构)。每通道独立链路状态。
 *
 * 三极管求解逻辑与 src/audio/wdf/triode.ts 一致——改动请三边同步。
 */
const processorSource = `
(() => {
const KOREN_12AX7 = { mu: 100, ex: 1.4, kg: 1060, kp: 600, kvb: 300 };
const KOREN_6V6 = { mu: 9.7, ex: 1.35, kg: 1030, kp: 48, kvb: 1200 };
const OS = 4, NT = 48;

function korenIp(P, vgk, vpk) {
  if (vpk <= 0) return 0;
  const inner = P.kp * (1 / P.mu + vgk / Math.sqrt(P.kvb + vpk * vpk));
  const softplus = inner > 30 ? inner : Math.log1p(Math.exp(inner));
  const e1 = (vpk / P.kp) * softplus;
  if (e1 <= 0) return 0;
  return Math.pow(e1, P.ex) / P.kg;
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
      j = (j + 1) % NT;
    }
    return acc;
  }
}

class TriodeStage {
  constructor(fs, opts) {
    this.T = 1 / fs;
    this.Bplus = opts.Bplus ?? 300;
    this.Rp = opts.Rp ?? 100e3;
    const Rk = opts.Rk ?? 1.5e3;
    const Ck = opts.Ck ?? 22e-6;
    this.Co = opts.Co ?? 22e-9;
    this.Rload = opts.Rload ?? 1e6;
    this.koren = opts.koren ?? KOREN_12AX7;
    this.Rs = opts.Rs ?? 68e3;
    this.Gk = Ck > 0 ? (2 * Ck) / this.T : 0;
    this.Rkk = 1 / (1 / Rk + this.Gk);
    this.vCkPrev = 0;
    this.iCkPrev = 0;
    this.vkPrev = 0;
    this.iHk = 0;
    this.vcOut = 0;
    this.iOutPrev = 0;
    this.ipPrev = 0.0012;
  }

  clampGrid(vg) {
    const vgk = vg - this.vkPrev;
    if (vgk <= 0.7) return vg;
    const vOn = this.vkPrev + 0.7;
    return (vg / this.Rs + vOn / 1000) / (1 / this.Rs + 1 / 1000);
  }

  residual(vg, ip) {
    const vk = (ip - this.iHk) * this.Rkk;
    const vp = this.Bplus - ip * this.Rp;
    return ip - korenIp(this.koren, vg - vk, vp - vk);
  }

  process(vgIn) {
    const vg = this.clampGrid(vgIn);
    this.iHk = this.Gk > 0 ? -this.Gk * this.vCkPrev - this.iCkPrev : 0;
    let ip = this.ipPrev;
    for (let iter = 0; iter < 12; iter++) {
      const f0 = this.residual(vg, ip);
      if (Math.abs(f0) < 1e-9) break;
      const h = Math.max(1e-7, Math.abs(ip) * 1e-5);
      const df = (this.residual(vg, ip + h) - f0) / h;
      if (df === 0 || !Number.isFinite(df)) break;
      let step = f0 / df;
      if (step > 0.005) step = 0.005;
      else if (step < -0.005) step = -0.005;
      ip -= step;
      if (ip < 0) ip = 0;
    }
    this.ipPrev = ip;
    const vk = (ip - this.iHk) * this.Rkk;
    const iCk = this.Gk > 0 ? this.Gk * vk + this.iHk : 0;
    this.vCkPrev = vk;
    this.iCkPrev = iCk;
    this.vkPrev = vk;
    const vp = this.Bplus - ip * this.Rp;
    const a = this.T / (2 * this.Co);
    const vc = (this.vcOut + a * (vp / this.Rload + this.iOutPrev)) / (1 + a / this.Rload);
    const iOut = (vp - vc) / this.Rload;
    this.vcOut = vc;
    this.iOutPrev = iOut;
    return vp - vc;
  }
}

class WdfChampProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'gain', defaultValue: 50, minValue: 0, maxValue: 100 },
      // 线性增益(dB 域由外层转换),默认 -6dB ≈ 0.5
      { name: 'master', defaultValue: 0.5, minValue: 0, maxValue: 2 },
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
      st1: new TriodeStage(fs, { Rk: 820, Ck: 0, Rs: 68e3 }),
      st2: new TriodeStage(fs, { Rs: 100e3 }),
      pw: new TriodeStage(fs, {
        koren: KOREN_6V6, Bplus: 285, Rp: 5e3, Rk: 250, Ck: 0,
        Co: 1e-3, Rload: 1e6, Rs: 220e3,
      }),
      up: new Up4(this.fir),
      down: new Down4(this.fir),
      xfHpX1: 0, xfHpY1: 0, xfLpY1: 0,
    };
  }

  transformer(c, x) {
    const fs = sampleRate * OS;
    const T = 1 / fs;
    const rcHp = 1 / (2 * Math.PI * 80);
    const aHp = rcHp / (rcHp + T);
    const yHp = aHp * (c.xfHpY1 + x - c.xfHpX1);
    c.xfHpX1 = x;
    c.xfHpY1 = yHp;
    const rcLp = 1 / (2 * Math.PI * 6500);
    const aLp = T / (rcLp + T);
    c.xfLpY1 = c.xfLpY1 + aLp * (yHp - c.xfLpY1);
    return c.xfLpY1;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    while (this.chains.length < input.length) this.chains.push(this.createChain());

    const drive = 1 + (params.gain[0] / 100) * 29;
    const master = params.master[0]; // 线性增益,外层已做 dB 转换
    const osIn = new Float32Array(OS);
    const osOut = new Float32Array(OS);

    for (let ch = 0; ch < input.length; ch++) {
      const c = this.chains[ch];
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) {
        c.up.process(osIn, inp[i]);
        for (let k = 0; k < OS; k++) {
          const s1 = c.st1.process(osIn[k] * drive);
          const s2 = c.st2.process(s1 * 0.08);
          const p = c.pw.process(s2 * 0.25);
          osOut[k] = this.transformer(c, p) / 250;
        }
        out[i] = c.down.process(osOut[0], osOut[1], osOut[2], osOut[3]) * master;
      }
    }
    return true;
  }
}

registerProcessor('wdf-champ', WdfChampProcessor);
})();
`;

let loaded = false;

/** 幂等加载,使用前必须先 await */
export async function loadChampWdf(ctx: AudioContext): Promise<void> {
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
