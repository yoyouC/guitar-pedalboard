/**
 * WDF Bogner 实验箱头的 AudioWorklet 处理器(Blob 内联,免构建配置)。
 *
 * 链路(Bogner Ecstasy 高增益通道风格):
 *   输入 → 130Hz 高通(紧实低频)→ drive(GAIN)
 *   → 12AX7 级 1(2.7k + 0.68uF 部分旁路,中高频前倾)
 *   → 级 2(10k 无旁路,冷偏置,不对称削波)
 *   → 级 3(820 + 22uF 全旁路,热增益)
 *   → EL34 推挽后级(近似 Koren)→ 输出变压器(90Hz HP + 6kHz LP)→ 输出
 *   内部 4x 过采样:多相升采样 + 31 阶 FIR 抗混叠降采样。每通道独立链路。
 *
 * 三极管求解与重采样逻辑同 src/audio/wdf/triode.ts、resample.ts。
 */
const processorSource = `
(() => {
const KOREN_12AX7 = { mu: 100, ex: 1.4, kg: 1060, kp: 600, kvb: 300 };
const KOREN_EL34 = { mu: 11, ex: 1.35, kg: 1030, kp: 42, kvb: 1200 };
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
    this.Co = opts.Co ?? 4.7e-9;
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

  solveGrid(vgSrc, vk) {
    // 隐式二极管栅流:Newton 内嵌,无状态延迟(延迟版高激励下产生极限环)
    let vg = vgSrc;
    for (let gi = 0; gi < 4; gi++) {
      const vgk = vg - vk;
      if (vgk <= 0) break;
      const x = Math.min(vgk / 0.0414, 20);
      const ig = 1e-9 * (Math.exp(x) - 1);
      if (ig < 1e-12) break;
      const vgNew = vgSrc - this.Rs * ig;
      const next = vg + (vgNew - vg) * 0.5;
      if (Math.abs(next - vg) < 1e-5) { vg = next; break; }
      vg = next;
    }
    return vg;
  }

  residual(ip) {
    const vk = (ip - this.iHk) * this.Rkk;
    const vp = this.Bplus - ip * this.Rp;
    const vg = this.solveGrid(this.vgSrc, vk);
    return ip - korenIp(this.koren, vg - vk, vp - vk);
  }

  process(vgIn) {
    this.vgSrc = vgIn;
    this.iHk = this.Gk > 0 ? -this.Gk * this.vCkPrev - this.iCkPrev : 0;
    let ip = this.ipPrev;
    for (let iter = 0; iter < 12; iter++) {
      const f0 = this.residual(ip);
      if (Math.abs(f0) < 1e-9) break;
      const h = Math.max(1e-7, Math.abs(ip) * 1e-5);
      const df = (this.residual(ip + h) - f0) / h;
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

class WdfBognerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'gain', defaultValue: 55, minValue: 0, maxValue: 100 }];
  }

  constructor() {
    super();
    this.fir = makeFIR();
    this.chains = [];
  }

  createChain() {
    const fs = sampleRate * OS;
    return {
      st1: new TriodeStage(fs, { Rk: 2.7e3, Ck: 0.68e-6, Rs: 34e3 }),
      st2: new TriodeStage(fs, { Rk: 10e3, Ck: 0, Rs: 100e3 }),
      st3: new TriodeStage(fs, { Rk: 820, Ck: 22e-6, Rs: 100e3 }),
      pw: new TriodeStage(fs, {
        koren: KOREN_EL34, Bplus: 350, Rp: 4e3, Rk: 250, Ck: 0,
        Co: 1e-3, Rload: 1e6, Rs: 220e3,
      }),
      up: new Up4(this.fir),
      down: new Down4(this.fir),
      hpIn: { x1: 0, y1: 0 },   // 输入 130Hz 高通
      xfHp: { x1: 0, y1: 0 },   // 变压器 90Hz 高通
      xfLpY1: 0,
    };
  }

  onePoleHp(st, x, fc) {
    const T = 1 / (sampleRate * OS);
    const rc = 1 / (2 * Math.PI * fc);
    const a = rc / (rc + T);
    const y = a * (st.y1 + x - st.x1);
    st.x1 = x;
    st.y1 = y;
    return y;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    while (this.chains.length < input.length) this.chains.push(this.createChain());

    const drive = 1 + (params.gain[0] / 100) * 39;
    const osIn = new Float32Array(OS);
    const osOut = new Float32Array(OS);
    const T = 1 / (sampleRate * OS);
    const rcLp = 1 / (2 * Math.PI * 6000);
    const aLp = T / (rcLp + T);

    for (let ch = 0; ch < input.length; ch++) {
      const c = this.chains[ch];
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) {
        c.up.process(osIn, inp[i]);
        for (let k = 0; k < OS; k++) {
          const x = this.onePoleHp(c.hpIn, osIn[k], 130);
          const s1 = c.st1.process(x * drive);
          const s2 = c.st2.process(s1 * 0.06);
          const s3 = c.st3.process(s2 * 0.10);
          const p = c.pw.process(s3 * 0.22);
          const y = this.onePoleHp(c.xfHp, p, 90);
          c.xfLpY1 = c.xfLpY1 + aLp * (y - c.xfLpY1);
          osOut[k] = c.xfLpY1 / 250;
        }
        out[i] = c.down.process(osOut[0], osOut[1], osOut[2], osOut[3]);
      }
    }
    return true;
  }
}

registerProcessor('wdf-bogner', WdfBognerProcessor);
})();
`;

let loaded = false;

/** 幂等加载,使用前必须先 await */
export async function loadBognerWdf(ctx: AudioContext): Promise<void> {
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
