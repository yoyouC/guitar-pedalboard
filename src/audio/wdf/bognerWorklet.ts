/**
 * WDF Bogner 实验箱头的 AudioWorklet 处理器(Blob 内联,免构建配置)。
 *
 * 链路(Bogner Ecstasy 高增益通道风格):
 *   输入 → 130Hz 高通(紧实低频)→ drive(GAIN)
 *   → 12AX7 级 1(2.7k + 0.68uF 部分旁路,中高频前倾)
 *   → 级 2(10k 无旁路,冷偏置,不对称削波——顺滑感的来源)
 *   → 级 3(820 + 22uF 全旁路,热增益)
 *   → EL34 推挽后级(近似 Koren 功率管)→ 输出变压器(90Hz HP + 6kHz LP)
 *   → 输出(音色栈/MASTER 由外层原生节点负责)
 *   内部 4x 过采样;各级均带栅流钳位。
 *
 * 处理器源码为纯 JS 字符串,三极管求解逻辑与 src/audio/wdf/triode.ts 一致。
 */
const processorSource = `
const KOREN_12AX7 = { mu: 100, ex: 1.4, kg: 1060, kp: 600, kvb: 300 };
const KOREN_EL34 = { mu: 11, ex: 1.35, kg: 1030, kp: 42, kvb: 1200 };

function korenIp(P, vgk, vpk) {
  if (vpk <= 0) return 0;
  const inner = P.kp * (1 / P.mu + vgk / Math.sqrt(P.kvb + vpk * vpk));
  const softplus = inner > 30 ? inner : Math.log1p(Math.exp(inner));
  const e1 = (vpk / P.kp) * softplus;
  if (e1 <= 0) return 0;
  return Math.pow(e1, P.ex) / P.kg;
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

const OS = 4;

class WdfBognerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'gain', defaultValue: 55, minValue: 0, maxValue: 100 }];
  }

  constructor() {
    super();
    const fs = sampleRate * OS;
    this.stage1 = new TriodeStage(fs, { Rk: 2.7e3, Ck: 0.68e-6, Rs: 34e3 });
    this.stage2 = new TriodeStage(fs, { Rk: 10e3, Ck: 0, Rs: 100e3 });
    this.stage3 = new TriodeStage(fs, { Rk: 820, Ck: 22e-6, Rs: 100e3 });
    this.power = new TriodeStage(fs, {
      koren: KOREN_EL34, Bplus: 350, Rp: 4e3, Rk: 250, Ck: 0,
      Co: 1e-3, Rload: 1e6, Rs: 220e3,
    });
    this.prevInput = 0;
    this.hpX1 = 0;
    this.hpY1 = 0;
    this.xfHpX1 = 0;
    this.xfHpY1 = 0;
    this.xfLpY1 = 0;
    this.fir = [0, 0, 0, 0];
  }

  onePoleHp(x, fc, fs, st) {
    const T = 1 / fs;
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

    const fs = sampleRate * OS;
    const drive = 1 + (params.gain[0] / 100) * 39; // GAIN: 1 ~ 40
    const FIR = [0.125, 0.375, 0.375, 0.125];
    const hpSt = { x1: this.hpX1, y1: this.hpY1 };
    const xfHpSt = { x1: this.xfHpX1, y1: this.xfHpY1 };

    for (let ch = 0; ch < input.length; ch++) {
      const inp = input[ch];
      const out = output[ch];
      let x0 = this.prevInput;
      for (let i = 0; i < inp.length; i++) {
        for (let k = 1; k <= OS; k++) {
          let x = x0 + ((inp[i] - x0) * k) / OS;
          // 输入高通 130Hz:低频不进削波级,保持紧实
          x = this.onePoleHp(x, 130, fs, hpSt);
          const s1 = this.stage1.process(x * drive);
          const s2 = this.stage2.process(s1 * 0.06);
          const s3 = this.stage3.process(s2 * 0.10);
          const p = this.power.process(s3 * 0.22);
          // 输出变压器 90Hz HP
          let y = this.onePoleHp(p, 90, fs, xfHpSt);
          // 6kHz LP
          const rcLp = 1 / (2 * Math.PI * 6000);
          const aLp = (1 / fs) / (rcLp + 1 / fs);
          this.xfLpY1 = this.xfLpY1 + aLp * (y - this.xfLpY1);
          this.fir[k - 1] = this.xfLpY1 / 250;
        }
        out[i] =
          FIR[0] * this.fir[0] + FIR[1] * this.fir[1] +
          FIR[2] * this.fir[2] + FIR[3] * this.fir[3];
        x0 = inp[i];
      }
      this.prevInput = x0;
    }
    this.hpX1 = hpSt.x1;
    this.hpY1 = hpSt.y1;
    this.xfHpX1 = xfHpSt.x1;
    this.xfHpY1 = xfHpSt.y1;
    return true;
  }
}

registerProcessor('wdf-bogner', WdfBognerProcessor);
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
