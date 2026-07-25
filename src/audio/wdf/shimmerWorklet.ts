/**
 * 微光混响(Shimmer Reverb)的 AudioWorklet 处理器(Blob 内联,免构建配置)。
 *
 * 链路:20ms 预延迟 → 4 线 FDN 混响(TIME=RT60,DAMP=环内阻尼 LP,环内 30Hz HP
 * 防 DC 堆积,Hadamard×0.5 混合)→ 湿声交替取号求和 → 双读头 Hann 窗调制延迟
 * +1 八度变调(SHIMMER 注入反馈环 + 直混湿声)→ MIX 等功率干湿交叉淡化。
 * 线性时变系统,不过采样,直接跑 sampleRate。IIFE 隔离全局名,每通道独立链。
 *
 * DSP 逻辑与 src/audio/wdf/shimmerReverb.ts 一致——改动请两边同步。
 */
const processorSource = `(() => {
const LINE_LENS_48K = [1517, 1747, 1979, 2213];
const PREDELAY_S = 0.02;
const GRAIN_S = 0.085;
const HP_FC = 30;
const SHIM_INJ = 0.5;
const SHIM_OUT = 0.8;
// 环内 LP/HP 中频带实测附加衰减(dB/s,damp=0 基准),setTime 预补偿
const LOOP_FILTER_LOSS_DBPS = 2.1;

class ShimmerReverb {
  constructor(fs, channel) {
    this.fs = fs;
    const scale = channel % 2 === 1 ? 1.0041 : 1.0;
    this.lines = LINE_LENS_48K.map((len48) => {
      const len = Math.max(16, Math.round((len48 / 48000) * fs * scale));
      return new Float32Array(len);
    });
    this.pos = [0, 0, 0, 0];
    this.g = [0, 0, 0, 0];
    this.lp = [0, 0, 0, 0];
    this.hp = [0, 0, 0, 0];
    this.fb = [0, 0, 0, 0];
    this.pdBuf = new Float32Array(Math.max(1, Math.round(PREDELAY_S * fs)));
    this.pdPos = 0;
    this.G = Math.max(64, Math.round(GRAIN_S * fs));
    this.sBuf = new Float32Array(this.G + 8);
    this.sPos = 0;
    this.ph0 = channel % 2 === 1 ? 0.31 : 0;
    this.ph1 = (this.ph0 + 0.5) % 1;
    this.shHp = 0;
    this.wetPrev = 0;
    const T = 1 / fs;
    this.aHp = T / (1 / (2 * Math.PI * HP_FC) + T);
    this.aDamp = T / (1 / (2 * Math.PI * 10000) + T);
    this.sGain = 0;
    this.dryGain = 1;
    this.wetGain = 0;
    this.setTime(4.5);
    this.setShimmer(40);
    this.setDamp(40);
    this.setMix(35);
  }

  setTime(seconds) {
    const t60 = Math.min(8, Math.max(2, seconds));
    for (let i = 0; i < 4; i++) {
      const d = this.lines[i].length / this.fs;
      this.g[i] = Math.pow(10, (-3 * d) / t60 + (LOOP_FILTER_LOSS_DBPS * d) / 20);
    }
  }

  setShimmer(pct) {
    this.sGain = Math.min(100, Math.max(0, pct)) / 100;
  }

  setDamp(pct) {
    const p = Math.min(100, Math.max(0, pct)) / 100;
    const fc = 10000 * Math.pow(0.1, p);
    const T = 1 / this.fs;
    this.aDamp = T / (1 / (2 * Math.PI * fc) + T);
  }

  setMix(pct) {
    const theta = (Math.min(100, Math.max(0, pct)) / 100) * (Math.PI / 2);
    this.dryGain = Math.cos(theta);
    this.wetGain = Math.sin(theta);
  }

  shift(x) {
    const L = this.sBuf.length;
    this.sBuf[this.sPos] = x;
    this.sPos = (this.sPos + 1) % L;
    let acc = 0;
    for (let k = 0; k < 2; k++) {
      let ph = k === 0 ? this.ph0 : this.ph1;
      ph += 1 / this.G;
      if (ph >= 1) ph -= 1;
      if (k === 0) this.ph0 = ph;
      else this.ph1 = ph;
      const w = 0.5 * (1 - Math.cos(2 * Math.PI * ph));
      const d = this.G * (1 - ph);
      let rd = this.sPos - 1 - d;
      if (rd < 0) rd += L;
      const i0 = Math.floor(rd);
      const fr = rd - i0;
      const i1 = (i0 + 1) % L;
      acc += w * (this.sBuf[i0] + fr * (this.sBuf[i1] - this.sBuf[i0]));
    }
    return acc;
  }

  process(x) {
    const pre = this.pdBuf[this.pdPos];
    this.pdBuf[this.pdPos] = x;
    this.pdPos = (this.pdPos + 1) % this.pdBuf.length;

    this.shHp += this.aHp * (this.wetPrev - this.shHp);
    const shim = this.sGain * this.shift(this.wetPrev - this.shHp);

    let wet = 0;
    for (let i = 0; i < 4; i++) {
      const buf = this.lines[i];
      const out = buf[this.pos[i]];
      this.lp[i] += this.aDamp * (out - this.lp[i]);
      this.hp[i] += this.aHp * (this.lp[i] - this.hp[i]);
      this.fb[i] = this.g[i] * (this.lp[i] - this.hp[i]);
      wet += i % 2 === 0 ? out : -out;
    }

    const inj = SHIM_INJ * shim;
    const f0 = this.fb[0], f1 = this.fb[1], f2 = this.fb[2], f3 = this.fb[3];
    const m0 = 0.5 * (f0 + f1 + f2 + f3);
    const m1 = 0.5 * (f0 - f1 + f2 - f3);
    const m2 = 0.5 * (f0 + f1 - f2 - f3);
    const m3 = 0.5 * (f0 - f1 - f2 + f3);
    const m = [m0, m1, m2, m3];
    for (let i = 0; i < 4; i++) {
      this.lines[i][this.pos[i]] = pre + m[i] + inj;
      this.pos[i] = (this.pos[i] + 1) % this.lines[i].length;
    }

    wet *= 0.25;
    this.wetPrev = wet;
    return this.dryGain * x + this.wetGain * (wet + SHIM_OUT * shim);
  }
}

class ShimmerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'time', defaultValue: 4.5, minValue: 2, maxValue: 8 },
      { name: 'shimmer', defaultValue: 40, minValue: 0, maxValue: 100 },
      { name: 'damp', defaultValue: 40, minValue: 0, maxValue: 100 },
      { name: 'mix', defaultValue: 35, minValue: 0, maxValue: 100 },
    ];
  }

  constructor() {
    super();
    this.chains = [];
    this.lastParams = null;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    while (this.chains.length < input.length) {
      this.chains.push(new ShimmerReverb(sampleRate, this.chains.length));
    }

    const time = params.time[0];
    const shimmer = params.shimmer[0];
    const damp = params.damp[0];
    const mix = params.mix[0];
    const lp = this.lastParams;
    const changed =
      !lp || lp[0] !== time || lp[1] !== shimmer || lp[2] !== damp || lp[3] !== mix;
    if (changed) {
      for (const c of this.chains) {
        c.setTime(time);
        c.setShimmer(shimmer);
        c.setDamp(damp);
        c.setMix(mix);
      }
      this.lastParams = [time, shimmer, damp, mix];
    }

    for (let ch = 0; ch < input.length; ch++) {
      const c = this.chains[ch];
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) out[i] = c.process(inp[i]);
    }
    return true;
  }
}

registerProcessor('wdf-shimmer', ShimmerProcessor);
})();`;

let loaded = false;

/** 幂等加载,使用前必须先 await */
export async function loadShimmerWdf(ctx: AudioContext): Promise<void> {
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
