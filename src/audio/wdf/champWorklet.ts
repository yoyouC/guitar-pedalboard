/**
 * WDF Champ 实验箱头的 AudioWorklet 处理器(Blob 内联,免构建配置)。
 *
 * 链路(5F1 Champ 风格,简化):
 *   输入 → drive(GAIN)→ 12AX7 共阴极级 1 → 栅流钳位近似(soft clamp)
 *   → 12AX7 共阴极级 2 → 6V6 单端后级(静态 tanh,占位简化)→ MASTER → 输出
 *   内部 4x 过采样(线性插值升 / 均值降)。
 *
 * 处理器源码为纯 JS 字符串,与 src/audio/wdf/triode.ts(TS 参考实现,
 * 可用 npm run wdf:test 数值验证)保持逻辑一致——改动请两边同步。
 */
const processorSource = `
const KOREN = { mu: 100, ex: 1.4, kg: 1060, kp: 600, kvb: 300 };

function korenIp(vgk, vpk) {
  if (vpk <= 0) return 0;
  const inner = KOREN.kp * (1 / KOREN.mu + vgk / Math.sqrt(KOREN.kvb + vpk * vpk));
  const softplus = inner > 30 ? inner : Math.log1p(Math.exp(inner));
  const e1 = (vpk / KOREN.kp) * softplus;
  if (e1 <= 0) return 0;
  return Math.pow(e1, KOREN.ex) / KOREN.kg;
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
    this.Gk = Ck > 0 ? (2 * Ck) / this.T : 0;
    this.Rkk = 1 / (1 / Rk + this.Gk);
    this.vCkPrev = 0;
    this.iCkPrev = 0;
    this.iHk = 0;
    this.vcOut = 0;
    this.iOutPrev = 0;
    this.ipPrev = 0.0012;
  }

  residual(vg, ip) {
    const vk = (ip - this.iHk) * this.Rkk;
    const vp = this.Bplus - ip * this.Rp;
    return ip - korenIp(vg - vk, vp - vk);
  }

  process(vg) {
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
    const vp = this.Bplus - ip * this.Rp;
    const a = this.T / (2 * this.Co);
    const vc = (this.vcOut + a * (vp / this.Rload + this.iOutPrev)) / (1 + a / this.Rload);
    const iOut = (vp - vc) / this.Rload;
    this.vcOut = vc;
    this.iOutPrev = iOut;
    return vp - vc;
  }
}

const OS = 4; // 过采样倍率

class WdfChampProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'gain', defaultValue: 50, minValue: 0, maxValue: 100 },
      { name: 'master', defaultValue: 60, minValue: 0, maxValue: 100 },
    ];
  }

  constructor() {
    super();
    const fs = sampleRate * OS;
    this.stage1 = new TriodeStage(fs, { Rk: 820, Ck: 0 }); // V1B 冷偏置无旁路(bright)
    this.stage2 = new TriodeStage(fs, {});
    this.prevInput = 0;
    this.prevOutput = 0;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;

    const drive = 1 + (params.gain[0] / 100) * 29;      // GAIN: 1 ~ 30
    const master = (params.master[0] / 100) * 1.2;      // MASTER: 0 ~ 1.2

    for (let ch = 0; ch < input.length; ch++) {
      const inp = input[ch];
      const out = output[ch];
      let x0 = this.prevInput;
      let y0 = this.prevOutput;
      for (let i = 0; i < inp.length; i++) {
        // 4x 过采样:线性插值升采样 → 4 步 WDF → 均值降采样
        let acc = 0;
        for (let k = 1; k <= OS; k++) {
          const x = x0 + ((inp[i] - x0) * k) / OS;
          const s1 = this.stage1.process(x * drive);
          // 级间栅流钳位近似(模型不含栅流,软钳模仿栅极钳位)
          const vg2 = 1.5 * Math.tanh(s1 / 1.5);
          const s2 = this.stage2.process(vg2);
          // 6V6 单端后级(静态 tanh 占位):板压摆幅 ~100V 归一
          const p = Math.tanh(s2 / 60) * 2.0;
          acc += p;
        }
        const y = acc / OS;
        out[i] = y * master;
        x0 = inp[i];
        y0 = y;
      }
      this.prevInput = x0;
      this.prevOutput = y0;
    }
    return true;
  }
}

registerProcessor('wdf-champ', WdfChampProcessor);
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
