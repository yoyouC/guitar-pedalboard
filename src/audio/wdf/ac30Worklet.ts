/**
 * WDF AC30(Vox Top Boost 风格)箱头的 AudioWorklet 处理器(Blob 内联,免构建配置)。
 *
 * 链路(英伦 chime 清音/边缘破音):
 *   输入 → 60Hz 高通 → drive(GAIN,幂律行程:低档清音余量、高档快进破音)
 *   → 级1 12AX7 暖偏置(Rk 1.5k + 22µF 全旁路)→ ×0.025
 *   → 级2 12AX7 冷一点(Rk 2.7k + 0.68µF 部分旁路)→ ×0.075
 *   → 阴极跟随器(12AX7,Rk 100k,栅漏 +60V 偏置 → 近似透明缓冲)
 *   → top-boost 音色(BASS/MID/TREBLE/PRESENCE,50=平直,在后级之前)
 *   → ×0.8197 → EL84 后级(A 类,B+ 310V,Rp 4k,Rk 150 热偏置)
 *   → 输出变压器(75Hz HP + 5.5kHz LP + 2.5kHz 临场峰 chime)→ /100
 *   内部 4x 过采样:多相升采样 + 48 阶 Blackman-sinc FIR 降采样。每通道独立链路。
 *
 * 全部 Koren 级用二分法栅流钳位(阻尼定点在深激励下会 period-2 锁死,
 * 见 ac30Core.ts 注释)。逻辑与 src/audio/wdf/ac30Core.ts、resample.ts
 * 逐行一致——改动请三边同步。
 */
const processorSource = `
(() => {
const KOREN_12AX7 = { mu: 100, ex: 1.4, kg: 1060, kp: 600, kvb: 300 };
const KOREN_EL84 = { mu: 19, ex: 1.35, kg: 210, kp: 60, kvb: 500 };
const OS = 4, NT = 48;
// 链路网关常数(与 ac30Core.ts 的 AC30 一致)
const HP_IN = 60, DRIVE_MAX = 18, DRIVE_EXP = 1.8;
const A1 = 0.025, A2 = 0.075, A3 = 0.8197;
const XF_HP = 75, XF_LP = 5500, CHIME_F = 2500, CHIME_Q = 1, CHIME_G = 0.45, NORM = 100;
const BASS_F = 110, MID_F = 800, MID_Q = 1, TREBLE_F = 3000, PRES_F = 5000;
const TONE_DB = 12, PRES_DB = 8, SHELF_Q = 0.7071;

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
      j = (j + 1) % this.hist.length;
    }
    return acc;
  }
}

// 二分法隐式栅流钳位(单调方程必有根,全局收敛不 overshoot)
function solveGrid(Rs, vgSrc, vk) {
  if (vgSrc <= vk) return vgSrc;
  let lo = vk, hi = vgSrc;
  for (let gi = 0; gi < 14; gi++) {
    const mid = 0.5 * (lo + hi);
    const x = Math.min((mid - vk) / 0.0414, 20);
    const ig = 1e-9 * (Math.exp(x) - 1);
    const g = mid - vgSrc + Rs * ig;
    if (g > 0) hi = mid;
    else lo = mid;
  }
  return 0.5 * (lo + hi);
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
    this.iHk = 0;
    this.vcOut = 0;
    this.iOutPrev = 0;
    this.ipPrev = 0.0012;
    this.vgSrc = 0;
  }

  // 板极电压(含耦合网络交流负载的 KCL):(B+−vp)/Rp = ip + (vp−vc)/Rload
  plateVp(ip) {
    const r = this.Rp / this.Rload;
    return (this.Bplus - ip * this.Rp + r * this.vcOut) / (1 + r);
  }

  residual(ip) {
    const vk = (ip - this.iHk) * this.Rkk;
    const vp = this.plateVp(ip);
    const vg = solveGrid(this.Rs, this.vgSrc, vk);
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
    const vp = this.plateVp(ip);
    const a = this.T / (2 * this.Co);
    const vc = (this.vcOut + a * (vp / this.Rload + this.iOutPrev)) / (1 + a / this.Rload);
    const iOut = (vp - vc) / this.Rload;
    this.vcOut = vc;
    this.iOutPrev = iOut;
    return vp - vc;
  }
}

// 阴极跟随器:板极直连 B+,输出取自阴极;栅漏 +gridBias 直流偏置抬静态 vk。
// 外层 Ip 用持久括号二分(单调 F)+ Newton 抛光(消除量化格跳变本底)。
class CathodeFollower {
  constructor(fs, opts) {
    this.T = 1 / fs;
    this.Bplus = opts.Bplus ?? 300;
    this.Rk = opts.Rk ?? 100e3;
    this.Co = opts.Co ?? 4.7e-9;
    this.Rload = opts.Rload ?? 1e6;
    this.koren = opts.koren ?? KOREN_12AX7;
    this.Rs = opts.Rs ?? 68e3;
    this.gridBias = opts.gridBias ?? 0;
    this.Rkk = 1 / (1 / this.Rk + 1 / this.Rload); // Rk ∥ Rload(阴极交流负载)
    this.ipPrev = Math.max(4e-5, this.gridBias / this.Rk);
    this.vcOut = 0;
    this.iOutPrev = 0;
    this.vgSrc = 0;
  }

  // 阴极电压(含耦合负载的 KCL):vk = (ip + vc/Rload)·(Rk∥Rload)
  cathodeVk(ip) {
    return (ip + this.vcOut / this.Rload) * this.Rkk;
  }

  residual(ip) {
    const vk = this.cathodeVk(ip);
    const vg = solveGrid(this.Rs, this.vgSrc + this.gridBias, vk);
    return ip - korenIp(this.koren, vg - vk, this.Bplus - vk);
  }

  process(vgIn) {
    this.vgSrc = vgIn;
    const IP_MAX = this.Bplus / this.Rk;
    let lo = Math.max(0, this.ipPrev * 0.98 - 1e-9);
    let hi = Math.min(IP_MAX, this.ipPrev * 1.02 + 1e-9);
    let flo = this.residual(lo);
    let fhi = this.residual(hi);
    for (let g = 0; g < 24 && flo > 0 && lo > 0; g++) {
      hi = lo; fhi = flo; lo *= 0.5;
      flo = this.residual(lo);
    }
    for (let g = 0; g < 24 && fhi < 0 && hi < IP_MAX; g++) {
      lo = hi; flo = fhi; hi = Math.min(IP_MAX, hi * 2 + 1e-6);
      fhi = this.residual(hi);
    }
    let ip;
    if (flo >= 0) ip = lo;
    else if (fhi <= 0) ip = hi;
    else {
      for (let it = 0; it < 8; it++) {
        const mid = 0.5 * (lo + hi);
        if (this.residual(mid) > 0) hi = mid;
        else lo = mid;
      }
      ip = 0.5 * (lo + hi);
      for (let p = 0; p < 2; p++) {
        const f0 = this.residual(ip);
        if (Math.abs(f0) < 1e-13) break;
        const h = Math.max(1e-10, Math.abs(ip) * 1e-6);
        const df = (this.residual(ip + h) - f0) / h;
        if (df === 0 || !Number.isFinite(df)) break;
        ip -= f0 / df;
        if (ip < 0) ip = 0;
        else if (ip > IP_MAX) ip = IP_MAX;
      }
    }
    this.ipPrev = ip;
    const vk = this.cathodeVk(ip);
    const a = this.T / (2 * this.Co);
    const vc = (this.vcOut + a * (vk / this.Rload + this.iOutPrev)) / (1 + a / this.Rload);
    const iOut = (vk - vc) / this.Rload;
    this.vcOut = vc;
    this.iOutPrev = iOut;
    return vk - vc;
  }
}

class Biquad {
  constructor() {
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
  }
  set(b0, b1, b2, a0, a1, a2) {
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  alpha(fs, f, q) {
    const w0 = (2 * Math.PI * f) / fs;
    return { cs: Math.cos(w0), al: Math.sin(w0) / (2 * q) };
  }
  setLowshelf(fs, f, db, q) {
    const A = Math.pow(10, db / 40);
    const { cs, al } = this.alpha(fs, f, q);
    const sq = 2 * Math.sqrt(A) * al;
    this.set(
      A * (A + 1 - (A - 1) * cs + sq), 2 * A * (A - 1 - (A + 1) * cs), A * (A + 1 - (A - 1) * cs - sq),
      A + 1 + (A - 1) * cs + sq, -2 * (A - 1 + (A + 1) * cs), A + 1 + (A - 1) * cs - sq);
  }
  setHighshelf(fs, f, db, q) {
    const A = Math.pow(10, db / 40);
    const { cs, al } = this.alpha(fs, f, q);
    const sq = 2 * Math.sqrt(A) * al;
    this.set(
      A * (A + 1 + (A - 1) * cs + sq), -2 * A * (A - 1 + (A + 1) * cs), A * (A + 1 + (A - 1) * cs - sq),
      A + 1 - (A - 1) * cs + sq, 2 * (A - 1 - (A + 1) * cs), A + 1 - (A - 1) * cs - sq);
  }
  setPeaking(fs, f, db, q) {
    const A = Math.pow(10, db / 40);
    const { cs, al } = this.alpha(fs, f, q);
    this.set(1 + al * A, -2 * cs, 1 - al * A, 1 + al / A, -2 * cs, 1 - al / A);
  }
  setBandpass(fs, f, q) {
    const { cs, al } = this.alpha(fs, f, q);
    this.set(al, 0, -al, 1 + al, -2 * cs, 1 - al);
  }
  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

function toneDb(v, range) {
  return ((Math.min(100, Math.max(0, v)) - 50) / 50) * range;
}

class WdfAc30Processor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'gain', defaultValue: 30, minValue: 0, maxValue: 100 },
      { name: 'bass', defaultValue: 50, minValue: 0, maxValue: 100 },
      { name: 'mid', defaultValue: 55, minValue: 0, maxValue: 100 },
      { name: 'treble', defaultValue: 60, minValue: 0, maxValue: 100 },
      { name: 'presence', defaultValue: 55, minValue: 0, maxValue: 100 },
    ];
  }

  constructor() {
    super();
    this.fir = makeFIR();
    this.chains = [];
    this.lastTone = [-1, -1, -1, -1];
  }

  createChain() {
    const fs = sampleRate * OS;
    return {
      st1: new TriodeStage(fs, { Rk: 1.5e3, Ck: 22e-6, Rs: 68e3 }),
      st2: new TriodeStage(fs, { Rk: 2.7e3, Ck: 0.68e-6, Rs: 24.4e3 }),
      cf: new CathodeFollower(fs, { Rk: 100e3, Rs: 69.4e3, Rload: 1.22e6, gridBias: 60 }),
      pw: new TriodeStage(fs, {
        koren: KOREN_EL84, Bplus: 310, Rp: 4e3, Rk: 150, Ck: 0,
        Co: 1e-3, Rload: 100e3, Rs: 220e3,
      }),
      up: new Up4(this.fir),
      down: new Down4(this.fir),
      bass: new Biquad(),
      mid: new Biquad(),
      treble: new Biquad(),
      presence: new Biquad(),
      chime: (() => { const b = new Biquad(); b.setBandpass(fs, CHIME_F, CHIME_Q); return b; })(),
      hpIn: { x1: 0, y1: 0 },
      xfHp: { x1: 0, y1: 0 },
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

    const g = Math.min(100, Math.max(0, params.gain[0])) / 100;
    const drive = 1 + DRIVE_MAX * Math.pow(g, DRIVE_EXP);
    // 音色系数块率更新(50=平直=精确直通)
    const tv = [params.bass[0], params.mid[0], params.treble[0], params.presence[0]];
    if (this.lastTone.some((v, i) => Math.abs(v - tv[i]) > 1e-4)) {
      this.lastTone = tv.slice();
      const fs = sampleRate * OS;
      for (const c of this.chains) {
        c.bass.setLowshelf(fs, BASS_F, toneDb(tv[0], TONE_DB), SHELF_Q);
        c.mid.setPeaking(fs, MID_F, toneDb(tv[1], TONE_DB), MID_Q);
        c.treble.setHighshelf(fs, TREBLE_F, toneDb(tv[2], TONE_DB), SHELF_Q);
        c.presence.setHighshelf(fs, PRES_F, toneDb(tv[3], PRES_DB), SHELF_Q);
      }
    }

    const T = 1 / (sampleRate * OS);
    const rcLp = 1 / (2 * Math.PI * XF_LP);
    const aLp = T / (rcLp + T);
    const osIn = new Float32Array(OS);
    const osOut = new Float32Array(OS);

    for (let ch = 0; ch < input.length; ch++) {
      const c = this.chains[ch];
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) {
        c.up.process(osIn, inp[i]);
        for (let k = 0; k < OS; k++) {
          const x = this.onePoleHp(c.hpIn, osIn[k], HP_IN);
          const s1 = c.st1.process(x * drive);
          const s2 = c.st2.process(s1 * A1);
          const cf = c.cf.process(s2 * A2);
          const t = c.presence.process(c.treble.process(c.mid.process(c.bass.process(cf))));
          const p = c.pw.process(t * A3);
          const h = this.onePoleHp(c.xfHp, p, XF_HP);
          c.xfLpY1 = c.xfLpY1 + aLp * (h - c.xfLpY1);
          osOut[k] = (c.xfLpY1 + CHIME_G * c.chime.process(h)) / NORM;
        }
        out[i] = c.down.process(osOut[0], osOut[1], osOut[2], osOut[3]);
      }
    }
    return true;
  }
}

registerProcessor('wdf-ac30', WdfAc30Processor);
})();
`;

let loaded = false;

/** 幂等加载,使用前必须先 await */
export async function loadAc30Wdf(ctx: AudioContext): Promise<void> {
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
