/**
 * WDF Twin Reverb(Fender AB763 风格,美式清音)实验箱头 DSP 核——单一来源(ADR-0003)。
 *
 * 链路:
 *   输入 → 12AX7 级 1(Rk 1.5k + 25uF 全旁路,暖偏置)→ volume(GAIN)
 *   → 12AX7 级 2(同配置)→ 阴极跟随器(板极直连 B+,Vbias=95 偏冷静态,
 *     补偿 Koren 低 Vpk 区电流偏弱,跟随窗 ±90V,正常音量下透明)
 *   → 6L6 推挽后级近似(Koren mu=8.2,B+ 420V,栅流压缩是清音压缩的主要来源)
 *   → 输出变压器(60Hz HP + 5.5kHz LP)→ 输出
 *   音色栈/MASTER 用原生节点(见 twinAmpDef.ts)。内部 4x 过采样(resample.dsp.js)。
 *   每通道独立链路状态。
 *
 * TwinStage 与 triode.dsp.js 的 TriodeStage 的关键差异(自带变体,故放本文件):
 * 栅流钳位用二分法隐式求解(TriodeStage 的阻尼定点迭代在 vgk>0.85V 时发散至
 * 关断伪解,大激励下产生开关式极限环);外层 Newton 步长钳制
 * min(5mA, 25V/Rkk) 并带回溯线搜索;支持 cathodeTap/Vbias(CF 用)。
 *
 * 双模式消费:worklet 经 `?raw` 取源码字符串拼装 Blob;eval/测试直接 import。
 * 只用单行 import 与内联 export(buildProcessorSource 依赖此约定剥离)。
 * 权威来源(issue #7):以原 twinWorklet.ts 内联版为准逐表达式平移
 * (栅流二极管 nVt 字面量 0.0414、无 −1 项;旧 twinStages.ts core 用
 * 1.6*25.85e-3 且含 −1,已随 core 删除)。iterTotal/iterCount 为 eval
 * (wdf-twin-eval L0)保留的迭代统计字段,纯计数、不影响 DSP 数值。
 */
import { KOREN_12AX7, KOREN_EL34_APPROX, korenPlateCurrent } from './triode.dsp.js';
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from './resample.dsp.js';

/** 6L6 功率管的近似 Koren 参数:mu≈8.2(按任务书),其余沿用 EL34 行 */
export const KOREN_6L6_APPROX = { ...KOREN_EL34_APPROX, mu: 8.2 };

/**
 * TwinStage 选项
 * @typedef {object} TwinStageOptions
 * @property {number} [Bplus] 电源电压,默认 300V
 * @property {number} [Rp]    板极电阻,默认 100k;0 = 板极直连 B+(阴极跟随器)
 * @property {number} [Rk]    阴极电阻,默认 1.5k
 * @property {number} [Ck]    阴极旁路电容 F,默认 22uF;0 = 无旁路
 * @property {number} [Co]    输出耦合电容 F,默认 22nF
 * @property {number} [Rload] 输出负载,默认 1M
 * @property {object} [koren] Koren 参数(见 triode.dsp.js KorenParams)
 * @property {number} [Rs]    栅极驱动源内阻(配合栅流钳位),默认 68k
 * @property {number} [Vbias] 栅极 DC 偏置电压(CF 用,默认 0)
 * @property {boolean} [cathodeTap] true = 输出取自阴极(阴极跟随器),默认 false(板极输出)
 */

export class TwinStage {
  /**
   * @param {number} fs 采样率(含过采样倍率后的实际速率)
   * @param {TwinStageOptions} [opts]
   */
  constructor(fs, opts = {}) {
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
    // 步长钳制:每一步 vk 最多走 25V(防止大步长越过 koren 悬崖)
    this.maxStep = Math.min(0.005, 25 / this.Rkk);
    this.ipPrev = this.cathodeTap ? 0.001 : 0.0012;
    this.iHk = 0;
    this.vCkPrev = 0;
    this.iCkPrev = 0;
    this.vcOut = 0;
    this.iOutPrev = 0;
    this.vgSrc = 0;
    /** Newton 迭代统计(评测用,纯计数) */
    this.iterTotal = 0;
    this.iterCount = 0;
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
    return ip - korenPlateCurrent(this.koren, vg - vk, vp - vk);
  }

  /** 处理一个样本。vgIn 为栅极交流电压(V),返回经耦合电容后的输出(V)。 */
  process(vgIn) {
    this.vgSrc = this.Vbias + vgIn;
    this.iHk = this.Gk > 0 ? -this.Gk * this.vCkPrev - this.iCkPrev : 0;
    let ip = this.ipPrev;
    let f0 = this.residual(ip);
    for (let iter = 0; iter < 12; iter++) {
      this.iterTotal++;
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
    this.iterCount++;
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

/**
 * Twin 全链路引擎。process(inputs, outputs, params) 语义与
 * AudioWorkletProcessor.process 一致;采样率由构造注入(替代 worklet 全局
 * sampleRate),引擎内不含任何 AudioWorklet API。
 */
export class WdfTwinEngine {
  /** @param {number} sampleRate 基率采样率(引擎内部自行 ×OS_FACTOR) */
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.fir = makeAntiAliasFIR();
    /** @type {object[]} 每通道独立链路状态 */
    this.chains = [];
  }

  createChain() {
    const fs = this.sampleRate * OS_FACTOR;
    return {
      st1: new TwinStage(fs, { Rk: 1.5e3, Ck: 25e-6, Co: 22e-9, Rs: 34e3 }),
      st2: new TwinStage(fs, { Rk: 1.5e3, Ck: 25e-6, Co: 22e-9, Rs: 100e3 }),
      cf: new TwinStage(fs, {
        Rp: 0, Rk: 100e3, Ck: 0, Co: 22e-9, Rs: 47e3, Vbias: 95, cathodeTap: true,
      }),
      pw: new TwinStage(fs, {
        koren: KOREN_6L6_APPROX, Bplus: 420, Rp: 2e3, Rk: 250, Ck: 0,
        Co: 1e-3, Rload: 1e6, Rs: 220e3,
      }),
      up: new Upsampler4x(this.fir),
      down: new Decimator4x(this.fir),
      xfHp: { x1: 0, y1: 0 },   // 变压器 60Hz 高通
      xfLpY1: 0,                // 变压器 5.5kHz 低通
    };
  }

  onePoleHp(st, x, fc) {
    const T = 1 / (this.sampleRate * OS_FACTOR);
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
    const osIn = new Float32Array(OS_FACTOR);
    const osOut = new Float32Array(OS_FACTOR);
    const T = 1 / (this.sampleRate * OS_FACTOR);
    const rcLp = 1 / (2 * Math.PI * 5500);
    const aLp = T / (rcLp + T);

    for (let ch = 0; ch < input.length; ch++) {
      const c = this.chains[ch];
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) {
        c.up.process(osIn, inp[i]);
        for (let k = 0; k < OS_FACTOR; k++) {
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
