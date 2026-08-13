/**
 * WDF Twin Reverb 实验箱头的 AudioWorklet 处理器(Blob 内联,免构建配置)。
 *
 * 链路(Fender AB763 风格,美式清音):
 *   输入 → 12AX7 级 1(Rk 1.5k + 25uF 全旁路,暖偏置)→ volume(GAIN)
 *   → 12AX7 级 2(同配置)→ 阴极跟随器(板极直连 B+,Vbias=95 偏冷静态,
 *     补偿 Koren 低 Vpk 区电流偏弱,跟随窗 ±90V,正常音量下透明)
 *   → 6L6 推挽后级近似(Koren mu=8.2,B+ 420V,栅流压缩是清音压缩的主要来源)
 *   → 输出变压器(60Hz HP + 5.5kHz LP)→ 输出
 *   音色栈/MASTER 用原生节点(见 twinAmpDef.ts)。内部 4x 过采样:
 *   多相升采样 + 48 阶 Blackman-sinc FIR 抗混叠降采样。每通道独立链路。
 *
 * 电子管求解逻辑与 src/audio/wdf/twinStages.ts 一致——改动请两边同步。
 * 与 triode.ts 的关键差异:栅流钳位用隐式 Newton(TriodeStage 的阻尼定点
 * 迭代在 vgk>0.85V 时发散至关断伪解,大激励下产生开关式极限环)。
 */
import { createWorkletLoader } from '../workletLoader';

const processorSource = `
(() => {
const KOREN_12AX7 = { mu: 100, ex: 1.4, kg: 1060, kp: 600, kvb: 300 };
const KOREN_6L6 = { mu: 8.2, ex: 1.35, kg: 1030, kp: 42, kvb: 1200 };
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

// 与 twinStages.ts 的 TwinStage 同一份逻辑(隐式 Newton 栅流钳位 + 回溯线搜索)
class TwinStage {
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
    this.Vbias = opts.Vbias ?? 0;
    this.cathodeTap = opts.cathodeTap ?? false;
    this.Gk = Ck > 0 ? (2 * Ck) / this.T : 0;
    this.Rkk = 1 / (1 / Rk + this.Gk);
    this.maxStep = Math.min(0.005, 25 / this.Rkk);
    this.ipPrev = this.cathodeTap ? 0.001 : 0.0012;
    this.iHk = 0;
    this.vCkPrev = 0;
    this.iCkPrev = 0;
    this.vcOut = 0;
    this.iOutPrev = 0;
    this.vgSrc = 0;
  }

  solveGrid(vgSrc, vk) {
    // G(vg) = vg - vgSrc + Rs·ig(vg-vk) = 0,严格单调,根必在 [vk, vgSrc];
    // 二分 20 次保证 vgk 收敛深度(欠收敛会被指数二极管放大成板流抖动)
    if (vgSrc <= vk) return vgSrc;
    let lo = vk, hi = vgSrc;
    for (let gi = 0; gi < 20; gi++) {
      const mid = (lo + hi) / 2;
      const vgk = mid - vk;
      const ig = vgk > 0 ? 1e-9 * Math.exp(Math.min(vgk / 0.0414, 30)) : 0;
      const f = mid - vgSrc + this.Rs * ig;
      if (f > 0) hi = mid;
      else lo = mid;
    }
    return (lo + hi) / 2;
  }

  residual(ip) {
    const vk = (ip - this.iHk) * this.Rkk;
    const vp = this.Bplus - ip * this.Rp;
    const vg = this.solveGrid(this.vgSrc, vk);
    return ip - korenIp(this.koren, vg - vk, vp - vk);
  }

  process(vgIn) {
    this.vgSrc = this.Vbias + vgIn;
    this.iHk = this.Gk > 0 ? -this.Gk * this.vCkPrev - this.iCkPrev : 0;
    let ip = this.ipPrev;
    let f0 = this.residual(ip);
    for (let iter = 0; iter < 12; iter++) {
      if (Math.abs(f0) < 1e-9) break;
      const h = Math.max(1e-7, Math.abs(ip) * 1e-5);
      const df = (this.residual(ip + h) - f0) / h;
      if (df === 0 || !Number.isFinite(df)) break;
      let step = f0 / df;
      if (step > this.maxStep) step = this.maxStep;
      else if (step < -this.maxStep) step = -this.maxStep;
      let ipNew = ip - step;
      if (ipNew < 0) ipNew = 0;
      let fNew = this.residual(ipNew);
      for (let bt = 0; bt < 6 && Math.abs(fNew) > Math.abs(f0); bt++) {
        step *= 0.5;
        ipNew = ip - step;
        if (ipNew < 0) ipNew = 0;
        fNew = this.residual(ipNew);
      }
      ip = ipNew;
      f0 = fNew;
    }
    this.ipPrev = ip;
    const vk = (ip - this.iHk) * this.Rkk;
    const iCk = this.Gk > 0 ? this.Gk * vk + this.iHk : 0;
    this.vCkPrev = vk;
    this.iCkPrev = iCk;
    const vOut = this.cathodeTap ? vk : this.Bplus - ip * this.Rp;
    const a = this.T / (2 * this.Co);
    const vc = (this.vcOut + a * (vOut / this.Rload + this.iOutPrev)) / (1 + a / this.Rload);
    const iOut = (vOut - vc) / this.Rload;
    this.vcOut = vc;
    this.iOutPrev = iOut;
    return vOut - vc;
  }
}

class WdfTwinProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'gain', defaultValue: 40, minValue: 0, maxValue: 100 }];
  }

  constructor() {
    super();
    this.fir = makeFIR();
    this.chains = [];
  }

  createChain() {
    const fs = sampleRate * OS;
    return {
      st1: new TwinStage(fs, { Rk: 1.5e3, Ck: 25e-6, Co: 22e-9, Rs: 34e3 }),
      st2: new TwinStage(fs, { Rk: 1.5e3, Ck: 25e-6, Co: 22e-9, Rs: 100e3 }),
      cf: new TwinStage(fs, {
        Rp: 0, Rk: 100e3, Ck: 0, Co: 22e-9, Rs: 47e3, Vbias: 95, cathodeTap: true,
      }),
      pw: new TwinStage(fs, {
        koren: KOREN_6L6, Bplus: 420, Rp: 2e3, Rk: 250, Ck: 0,
        Co: 1e-3, Rload: 1e6, Rs: 220e3,
      }),
      up: new Up4(this.fir),
      down: new Down4(this.fir),
      xfHp: { x1: 0, y1: 0 },   // 变压器 60Hz 高通
      xfLpY1: 0,                // 变压器 5.5kHz 低通
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

    // AB763 volume 在级1/级2之间:对数手感(平方 taper),最大 0.4
    const vol = 0.4 * Math.pow(params.gain[0] / 100, 2);
    const ATT_PW = 0.6; // CF → 后级衰减(后级驱动量,清音压缩阈)
    const osIn = new Float32Array(OS);
    const osOut = new Float32Array(OS);
    const T = 1 / (sampleRate * OS);
    const rcLp = 1 / (2 * Math.PI * 5500);
    const aLp = T / (rcLp + T);

    for (let ch = 0; ch < input.length; ch++) {
      const c = this.chains[ch];
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) {
        c.up.process(osIn, inp[i]);
        for (let k = 0; k < OS; k++) {
          const s1 = c.st1.process(osIn[k]);
          const s2 = c.st2.process(s1 * vol);
          const cf = c.cf.process(s2);
          const p = c.pw.process(cf * ATT_PW);
          const y = this.onePoleHp(c.xfHp, p, 60);
          c.xfLpY1 = c.xfLpY1 + aLp * (y - c.xfLpY1);
          osOut[k] = c.xfLpY1 / 250;
        }
        out[i] = c.down.process(osOut[0], osOut[1], osOut[2], osOut[3]);
      }
    }
    return true;
  }
}

registerProcessor('wdf-twin', WdfTwinProcessor);
})();
`;

/** 幂等加载(按 AudioContext 注册),使用前必须先 await */
export const loadTwinWdf = createWorkletLoader(processorSource);
