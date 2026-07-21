/**
 * WDF 版 TS808 的 AudioWorklet 处理器(Blob 内联,免构建配置)。
 *
 * 链路:
 *   输入 → WDF 削波级(运放 + 反并联 1N4148 对,720Hz 反馈高通,DRIVE)
 *   → 音色级:723Hz 固定无源低通 + TONE 高架(3.2kHz,主动电路近似)
 *   → LEVEL(线性,dB 域由外层转换)→ 输出
 *   内部 4x 过采样:多相升采样 + 48 阶 FIR 抗混叠降采样。IIFE 隔离全局名。
 *
 * 削波级求解逻辑与 src/audio/wdf/diodeClipper.ts 一致——改动请两边同步。
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

class TsClipperStage {
  constructor(fs) {
    this.T = 1 / fs;
    this.R4 = 4.7e3;
    this.C3 = 0.047e-6;
    this.G4 = (2 * 51e-12) / this.T;
    this.Rf = 51e3 + 250e3;
    this.vc3 = 0;
    this.i1Prev = 0;
    this.ih4 = 0;
    this.vdPrev = 0;
  }

  setDrive(d) {
    this.Rf = 51e3 + 500e3 * Math.min(1, Math.max(0, d));
  }

  process(vin) {
    const a = this.T / (2 * this.C3);
    const i1 = (vin - this.vc3 - a * this.i1Prev) / (this.R4 + a);
    this.vc3 += a * (i1 + this.i1Prev);
    this.i1Prev = i1;

    const { Is, nVt } = DIODE;
    const gSum = 1 / this.Rf + this.G4;
    let vd = this.vdPrev;
    for (let iter = 0; iter < 12; iter++) {
      const f = 2 * Is * Math.sinh(vd / nVt) + vd * gSum + this.ih4 - i1;
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
    const iC4 = this.G4 * vd + this.ih4;
    this.ih4 = -this.G4 * vd - iC4;
    return vin + vd;
  }
}

class WdfTs808Processor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'drive', defaultValue: 45, minValue: 0, maxValue: 100 },
      { name: 'tone', defaultValue: 55, minValue: 0, maxValue: 100 },
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
    const c = new TsClipperStage(fs);
    return {
      clipper: c,
      up: new Up4(this.fir),
      down: new Down4(this.fir),
      lpY1: 0,     // 723Hz 无源低通
      toneLpY1: 0, // TONE 高架的低通分量
      lastDrive: -1,
    };
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    while (this.chains.length < input.length) this.chains.push(this.createChain());

    const T = 1 / (sampleRate * OS);
    const aLp = T / (1 / (2 * Math.PI * 723) + T);
    const aTone = T / (1 / (2 * Math.PI * 3200) + T);
    // tone 0~100 → 高架 dB(-12 ~ +3),同现行 ts808
    const toneDb = ((params.tone[0] - 50) / 50) * 15;
    const toneG = Math.pow(10, toneDb / 20);
    const level = params.level[0];
    const drive = params.drive[0] / 100;
    const osIn = new Float32Array(OS);
    const osOut = new Float32Array(OS);

    for (let ch = 0; ch < input.length; ch++) {
      const c = this.chains[ch];
      if (c.lastDrive !== drive) {
        c.clipper.setDrive(drive);
        c.lastDrive = drive;
      }
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) {
        c.up.process(osIn, inp[i]);
        for (let k = 0; k < OS; k++) {
          const s = c.clipper.process(osIn[k]);
          // 723Hz 无源低通
          c.lpY1 += aLp * (s - c.lpY1);
          // TONE 高架(一阶):low + g·(x - low)
          c.toneLpY1 += aTone * (c.lpY1 - c.toneLpY1);
          osOut[k] = c.toneLpY1 + toneG * (c.lpY1 - c.toneLpY1);
        }
        out[i] = c.down.process(osOut[0], osOut[1], osOut[2], osOut[3]) * level;
      }
    }
    return true;
  }
}

registerProcessor('wdf-ts808', WdfTs808Processor);
})();`;

let loaded = false;

/** 幂等加载,使用前必须先 await */
export async function loadTs808Wdf(ctx: AudioContext): Promise<void> {
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
