/**
 * WDF 版 Klon Centaur 的 AudioWorklet 处理器(Blob 内联,免构建配置)。
 *
 * 链路:
 *   输入 → 运放增益级(g = 10^(GAIN·46/20),1x~200x)
 *   → WDF 削波级(5.6k 串联 + 反并联 1N34A 锗管对地,每样本 Newton)
 *   → 干湿混合(双联 GAIN 电位器:低增益干声为主,即"透明"感)
 *   → TREBLE 高架(3kHz,±10dB)→ LEVEL(线性,dB 域由外层转换)→ 输出
 *   内部 4x 过采样:多相升采样 + 48 阶 FIR 抗混叠降采样。IIFE 隔离全局名。
 *
 * 削波级与旋钮映射逻辑与 src/audio/wdf/klonCentaur.ts 一致——改动请两边同步。
 */
const processorSource = `(() => {
const DIODE = { Is: 1e-6, nVt: 0.034 };
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

class KlonClipperStage {
  constructor() {
    this.Rser = 5.6e3;
    this.Rload = 27e3;
    this.vdPrev = 0;
  }

  process(vo) {
    const { Is, nVt } = DIODE;
    const gLeak = 1 / this.Rser + 1 / this.Rload;
    const iSrc = vo / this.Rser;
    let vd = this.vdPrev;
    for (let iter = 0; iter < 12; iter++) {
      const f = 2 * Is * Math.sinh(vd / nVt) + vd * gLeak - iSrc;
      if (Math.abs(f) < 1e-12) break;
      const df = ((2 * Is) / nVt) * Math.cosh(vd / nVt) + gLeak;
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

class WdfKlonProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'gain', defaultValue: 30, minValue: 0, maxValue: 100 },
      { name: 'treble', defaultValue: 50, minValue: 0, maxValue: 100 },
      { name: 'level', defaultValue: 1, minValue: 0, maxValue: 2 },
    ];
  }

  constructor() {
    super();
    this.fir = makeFIR();
    this.chains = [];
  }

  createChain() {
    return {
      clipper: new KlonClipperStage(),
      up: new Up4(this.fir),
      down: new Down4(this.fir),
      toneLpY1: 0, // TREBLE 高架的低通分量
    };
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    while (this.chains.length < input.length) this.chains.push(this.createChain());

    const T = 1 / (sampleRate * OS);
    // treble 0~100 → 高架 -10 ~ +10dB(dB 镜像对称:衰减时转角下移至 fc·G)
    const trebleDb = ((params.treble[0] - 50) / 50) * 10;
    const toneG = Math.pow(10, trebleDb / 20);
    const fcShelf = toneG >= 1 ? 3000 : 3000 * toneG;
    const aTone = T / (1 / (2 * Math.PI * fcShelf) + T);
    const level = params.level[0];
    const knob = params.gain[0] / 100;
    // 运放增益级:1x~200x(0~46dB 指数锥度)
    const g = Math.pow(10, (knob * 46) / 20);
    // 双联电位器 B 联干声权重:p = 1-knob 分压 + 求和电阻负载
    const p = 1 - knob;
    const dryW = (27e3 * p) / (p * (1 - p) * 100e3 + 27e3);
    const osIn = new Float32Array(OS);
    const osOut = new Float32Array(OS);

    for (let ch = 0; ch < input.length; ch++) {
      const c = this.chains[ch];
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) {
        c.up.process(osIn, inp[i]);
        for (let k = 0; k < OS; k++) {
          const vd = c.clipper.process(g * osIn[k]);
          const sum = vd + dryW * osIn[k];
          // TREBLE 高架(一阶):low + g·(x - low)
          c.toneLpY1 += aTone * (sum - c.toneLpY1);
          osOut[k] = c.toneLpY1 + toneG * (sum - c.toneLpY1);
        }
        out[i] = c.down.process(osOut[0], osOut[1], osOut[2], osOut[3]) * level;
      }
    }
    return true;
  }
}

registerProcessor('wdf-klon', WdfKlonProcessor);
})();`;

let loaded = false;

/** 幂等加载,使用前必须先 await */
export async function loadKlonWdf(ctx: AudioContext): Promise<void> {
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
