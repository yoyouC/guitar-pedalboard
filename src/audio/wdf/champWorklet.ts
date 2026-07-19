/**
 * WDF Champ 实验箱头的 AudioWorklet 处理器(Blob 内联,免构建配置)。
 *
 * 链路(5F1 Champ 风格):
 *   输入 → drive(GAIN)→ 12AX7 级 1(Rk820 无旁路,冷偏置 bright)
 *   → 级间衰减 → 12AX7 级 2(全旁路)
 *   → 6V6 单端后级(近似 Koren 功率管)→ 输出变压器(80Hz HP + 6.5kHz LP)
 *   → MASTER → 输出
 *   内部 4x 过采样(线性插值升采样 / 4 抽头对称 FIR 降采样)。
 *   各级均带栅流钳位(Vgk>0.7V 栅极导通,源内阻分压)。
 *
 * 处理器源码为纯 JS 字符串,与 src/audio/wdf/triode.ts(TS 参考实现,
 * 可用 npm run wdf:test 数值验证)保持逻辑一致——改动请两边同步。
 */
const processorSource = `
const KOREN_12AX7 = { mu: 100, ex: 1.4, kg: 1060, kp: 600, kvb: 300 };
const KOREN_6V6 = { mu: 9.7, ex: 1.35, kg: 1030, kp: 48, kvb: 1200 };

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
    this.stage1 = new TriodeStage(fs, { Rk: 820, Ck: 0, Rs: 68e3 });
    this.stage2 = new TriodeStage(fs, { Rs: 100e3 });
    // 6V6 单端后级:低 mu 功率管,5k 反射负载,大耦合电容近似透明
    this.power = new TriodeStage(fs, {
      koren: KOREN_6V6, Bplus: 285, Rp: 5e3, Rk: 250, Ck: 0,
      Co: 1e-3, Rload: 1e6, Rs: 220e3,
    });
    this.prevInput = 0;
    // 输出变压器单极点滤波器状态(80Hz HP + 6.5kHz LP)
    this.xfHpX1 = 0;
    this.xfHpY1 = 0;
    this.xfLpY1 = 0;
    // 降采样 FIR 历史
    this.fir = [0, 0, 0, 0];
  }

  transformer(x) {
    const fs = sampleRate * OS;
    const T = 1 / fs;
    // HP 80Hz: y = a*(y1 + x - x1), a = RC/(RC+T), RC = 1/(2π·80)
    const rcHp = 1 / (2 * Math.PI * 80);
    const aHp = rcHp / (rcHp + T);
    const yHp = aHp * (this.xfHpY1 + x - this.xfHpX1);
    this.xfHpX1 = x;
    this.xfHpY1 = yHp;
    // LP 6.5kHz: y = y1 + a*(x - y1), a = T/(RC+T)
    const rcLp = 1 / (2 * Math.PI * 6500);
    const aLp = T / (rcLp + T);
    const yLp = this.xfLpY1 + aLp * (yHp - this.xfLpY1);
    this.xfLpY1 = yLp;
    return yLp;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;

    const drive = 1 + (params.gain[0] / 100) * 29; // GAIN: 1 ~ 30
    const master = (params.master[0] / 100) * 1.2; // MASTER: 0 ~ 1.2
    const FIR = [0.125, 0.375, 0.375, 0.125];

    for (let ch = 0; ch < input.length; ch++) {
      const inp = input[ch];
      const out = output[ch];
      let x0 = this.prevInput;
      for (let i = 0; i < inp.length; i++) {
        for (let k = 1; k <= OS; k++) {
          const x = x0 + ((inp[i] - x0) * k) / OS;
          const s1 = this.stage1.process(x * drive);
          // 级间衰减(板压摆幅 → 后级栅极合适区间)
          const s2 = this.stage2.process(s1 * 0.08);
          // 后级栅极驱动(缩放到 6V6 栅压区间)
          const p = this.power.process(s2 * 0.25);
          // 输出变压器 + 归一化(板压摆幅数百 V)
          this.fir[k - 1] = this.transformer(p) / 250;
        }
        out[i] =
          (FIR[0] * this.fir[0] + FIR[1] * this.fir[1] +
           FIR[2] * this.fir[2] + FIR[3] * this.fir[3]) * master;
        x0 = inp[i];
      }
      this.prevInput = x0;
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
