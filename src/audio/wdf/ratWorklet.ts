/**
 * WDF 版 Pro Co RAT 的 AudioWorklet 处理器(Blob 内联,免构建配置)。
 *
 * 链路:
 *   输入 → WDF 失真级(可变增益运放:1.5kHz 反馈高通 + LM308 摆率 5.3kHz 低通,
 *   R5 + 反并联 1N914 对地硬削波,DIST)→ FILTER 反向单极点低通
 *   (475Hz 顺时 ~ 32kHz 逆时,与削波节点联立求解)→ LEVEL(线性,dB 域由外层转换)→ 输出
 *   内部 4x 过采样:多相升采样 + 48 阶 FIR 抗混叠降采样。IIFE 隔离全局名。
 *
 * 失真级求解逻辑与 src/audio/wdf/ratDistortion.ts 一致——改动请两边同步。
 */
const processorSource = `(() => {
const DIODE = { Is: 2.52e-9, nVt: 1.752 * 25.85e-3 };
const OS = 4, NT = 48;
const FILTER_MAX_HZ = 32000, FILTER_MIN_HZ = 475;

function filterToFreq(v) {
  const t = Math.min(100, Math.max(0, v)) / 100;
  return FILTER_MAX_HZ * Math.pow(FILTER_MIN_HZ / FILTER_MAX_HZ, t);
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

class RatStage {
  constructor(fs) {
    this.T = 1 / fs;
    this.R3 = 47;
    this.C3 = 2.2e-6;
    this.G5 = 1 / 1e3;
    this.C6 = 3.3e-9;
    this.a6 = this.T / (2 * this.C6);
    const rc = 1 / (2 * Math.PI * 5300);
    const k = (2 * rc) / this.T;
    this.slewA0 = 1 / (1 + k);
    this.slewB1 = (1 - k) / (1 + k);
    this.Rdist = 55e3;
    this.Rfilt = 1.5e3;
    this.vc3 = 0;
    this.i1Prev = 0;
    this.slewX1 = 0;
    this.slewY1 = 0;
    this.vc6 = 0;
    this.iFiltPrev = 0;
    this.vdPrev = 0;
  }

  setDrive(d) {
    this.Rdist = 100e3 * Math.min(1, Math.max(0, d));
  }

  setFilter(v) {
    this.Rfilt = 1 / (2 * Math.PI * filterToFreq(v) * this.C6);
  }

  process(vin) {
    const a3 = this.T / (2 * this.C3);
    const i1 = (vin - this.vc3 - a3 * this.i1Prev) / (this.R3 + a3);
    this.vc3 += a3 * (i1 + this.i1Prev);
    this.i1Prev = i1;
    const vg = vin + this.Rdist * i1;

    const v2 = this.slewA0 * (vg + this.slewX1) - this.slewB1 * this.slewY1;
    this.slewX1 = vg;
    this.slewY1 = v2;

    const { Is, nVt } = DIODE;
    const gf = 1 / (this.Rfilt + this.a6);
    const gSum = this.G5 + gf;
    const known6 = (this.vc6 + this.a6 * this.iFiltPrev) * gf;
    const c5 = v2 * this.G5;
    let vd = this.vdPrev;
    for (let iter = 0; iter < 12; iter++) {
      const f = vd * gSum - c5 - known6 + 2 * Is * Math.sinh(vd / nVt);
      if (Math.abs(f) < 1e-12) break;
      const df = gSum + ((2 * Is) / nVt) * Math.cosh(vd / nVt);
      let step = f / df;
      if (step > 0.2) step = 0.2;
      else if (step < -0.2) step = -0.2;
      vd -= step;
      if (vd > 1.0) vd = 1.0;
      else if (vd < -1.0) vd = -1.0;
    }
    this.vdPrev = vd;
    const iF = gf * vd - known6;
    this.vc6 += this.a6 * (iF + this.iFiltPrev);
    this.iFiltPrev = iF;
    return this.vc6;
  }
}

class WdfRatProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'drive', defaultValue: 55, minValue: 0, maxValue: 100 },
      { name: 'filter', defaultValue: 35, minValue: 0, maxValue: 100 },
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
      rat: new RatStage(fs),
      up: new Up4(this.fir),
      down: new Down4(this.fir),
      lastDrive: -1,
      lastFilter: -1,
    };
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    while (this.chains.length < input.length) this.chains.push(this.createChain());

    const level = params.level[0];
    const drive = params.drive[0] / 100;
    const filter = params.filter[0];
    const osIn = new Float32Array(OS);

    for (let ch = 0; ch < input.length; ch++) {
      const c = this.chains[ch];
      if (c.lastDrive !== drive) {
        c.rat.setDrive(drive);
        c.lastDrive = drive;
      }
      if (c.lastFilter !== filter) {
        c.rat.setFilter(filter);
        c.lastFilter = filter;
      }
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) {
        c.up.process(osIn, inp[i]);
        const y0 = c.rat.process(osIn[0]);
        const y1 = c.rat.process(osIn[1]);
        const y2 = c.rat.process(osIn[2]);
        const y3 = c.rat.process(osIn[3]);
        out[i] = c.down.process(y0, y1, y2, y3) * level;
      }
    }
    return true;
  }
}

registerProcessor('wdf-rat', WdfRatProcessor);
})();`;

let loaded = false;

/** 幂等加载,使用前必须先 await */
export async function loadRatWdf(ctx: AudioContext): Promise<void> {
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
