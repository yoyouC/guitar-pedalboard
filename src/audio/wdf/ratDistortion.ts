/**
 * WDF 版 Pro Co RAT 失真 DSP 核心(伴随模型/梯形积分,与 ngspice 参考逐节点同构)。
 *
 * 电路(ElectroSmash Pro Co Rat 分析,RAT2):
 *   Vin → 同相运放可变增益级:G(s) = 1 + Rdist·sC3/(1 + s·R3·C3)
 *         R3=47Ω,C3=2.2µF → 1.5kHz 以下增益 20dB/dec 滚降
 *         (频率选择性失真:低频少削波,RAT 紧实低频的来源)
 *       → LM308 摆率软化:5.3kHz 一阶低通
 *         (0.3V/µs 摆率在 9V 峰值摆幅下的全功率带宽 ≈ 5.3kHz)
 *       → R5(1k)+ 1N914 反并联二极管对地硬削波(截平 ≈ ±0.65V)
 *       → FILTER 级:R6(1.5k)+ Rfilt(0~100k 电位器)串联 C6(3.3nF)对地,
 *         可变一阶低通 475Hz(旋钮顺时到底)~ 32kHz(逆时到底),输出取 C6 电压
 *       → LEVEL → 输出
 *
 * 每样本:
 *   1) 增益网络 Z1(串联 R3-C3)支路电流 i1:线性,梯形精确解
 *   2) 5.3kHz 双线性一阶低通(与 ngspice 梯形积分一致)
 *   3) Newton 解削波节点 Vd:
 *        F(Vd) = (Vd-v2)/R5 + 2·Is·sinh(Vd/nVt) + iFilt(Vd) = 0
 *      其中 iFilt(Vd) = (Vd - vc6 - a6·iFiltPrev)/(Rfilt + a6) 为 FILTER
 *      串联 RC 支路电流(Vd 的线性函数),解析 Jacobian。
 *      该支路对削波节点有真实负载效应,故必须联立求解而非事后滤波。
 *   4) 梯形更新 C6 状态,输出 = V(C6)
 *
 * 理想化(与 spice 参考网表保持一致):运放视为理想(无供电轨饱和,
 * 削波全部由二极管完成);省略输入/级间/输出耦合电容(转角 ≤7Hz,带外);
 * 二极管不流体电阻 RS;DIST 电位器按线性行程(实物为对数 taper)。
 */

/** 1N914 硅二极管参数(与 1N4148 同族,WDF 文献标准值:chowdsp / Yeh 论文) */
export interface DiodeParams {
  Is: number;  // 饱和电流 A
  nVt: number; // n·Vt(发射系数 × 热电压)
}

export const DIODE_1N914: DiodeParams = {
  Is: 2.52e-9,
  nVt: 1.752 * 25.85e-3,
};

/** FILTER 旋钮行程(实测电路):0 = 逆时到底(32kHz,最亮),100 = 顺时到底(475Hz,最暗) */
export const FILTER_MAX_HZ = 32000;
export const FILTER_MIN_HZ = 475;

/** FILTER 旋钮 0~100 → 截止频率(反向,对数行程) */
export function filterToFreq(v: number): number {
  const t = Math.min(100, Math.max(0, v)) / 100;
  return FILTER_MAX_HZ * Math.pow(FILTER_MIN_HZ / FILTER_MAX_HZ, t);
}

export interface RatOptions {
  /** 采样率(含过采样倍率后的实际速率) */
  fs: number;
  R3?: number;   // 增益网络对地电阻,默认 47Ω
  C3?: number;   // 增益网络串联电容,默认 2.2µF(→ 1539Hz)
  R5?: number;   // 二极管串联电阻,默认 1k
  R6?: number;   // FILTER 固定电阻,默认 1.5k
  C6?: number;   // FILTER 电容,默认 3.3nF
  slewHz?: number; // LM308 摆率软化低通,默认 5.3kHz
  RdistMax?: number; // DIST 电位器满程,默认 100k
  diode?: DiodeParams;
}

const MAX_ITER = 12;
const TOL = 1e-12;
/** 二极管电压钳制(防 sinh 溢出;物理上 mA 级电流下 Vd 也不超 ±1V) */
const VD_CLAMP = 1.0;

export class RatStage {
  private readonly T: number;
  private readonly R3: number;
  private readonly C3: number;
  private readonly G5: number; // 1/R5
  private readonly C6: number;
  private readonly a6: number; // T/(2·C6)
  private readonly RdistMax: number;
  private readonly diode: DiodeParams;

  // 5.3kHz 双线性低通系数:y[n] = a0·(x[n]+x[n-1]) - b1·y[n-1]
  private readonly slewA0: number;
  private readonly slewB1: number;

  /** 增益级反馈电阻(0 ~ RdistMax),setDrive 设置 */
  private Rdist: number;
  /** FILTER 支路总电阻(R6 + 电位器部分),setFilter 设置 */
  private Rfilt: number;

  // 状态
  private vc3 = 0;      // C3 电容电压
  private i1Prev = 0;
  private slewX1 = 0;
  private slewY1 = 0;
  private vc6 = 0;      // C6 电容电压(= 输出)
  private iFiltPrev = 0;
  private vdPrev = 0;

  /** 求解器统计(评测用) */
  iterTotal = 0;
  iterCount = 0;

  constructor(opts: RatOptions) {
    this.T = 1 / opts.fs;
    this.R3 = opts.R3 ?? 47;
    this.C3 = opts.C3 ?? 2.2e-6;
    this.G5 = 1 / (opts.R5 ?? 1e3);
    const R6 = opts.R6 ?? 1.5e3;
    this.C6 = opts.C6 ?? 3.3e-9;
    this.a6 = this.T / (2 * this.C6);
    this.RdistMax = opts.RdistMax ?? 100e3;
    this.diode = opts.diode ?? DIODE_1N914;

    const rc = 1 / (2 * Math.PI * (opts.slewHz ?? 5300));
    const k = (2 * rc) / this.T;
    this.slewA0 = 1 / (1 + k);
    this.slewB1 = (1 - k) / (1 + k);

    this.Rdist = 0.55 * this.RdistMax;
    this.Rfilt = R6; // filter=0(32kHz)附近
  }

  /** drive 0~1 → Rdist = 0~100k(HF 增益 1 + Rdist/R3 ≈ 1 ~ 2130,即 0~66.6dB) */
  setDrive(drive: number): void {
    this.Rdist = this.RdistMax * Math.min(1, Math.max(0, drive));
  }

  /** filter 0~100(旋钮反向)→ 支路总电阻 R6+Rpot = 1/(2π·fc·C6) */
  setFilter(filter: number): void {
    this.Rfilt = 1 / (2 * Math.PI * filterToFreq(filter) * this.C6);
  }

  process(vin: number): number {
    // 1) Z1 支路电流(串联 R3-C3,梯形):
    //    vin = i1·R3 + vc3, vc3[n] = vc3[n-1] + a3·(i1[n]+i1[n-1])
    const a3 = this.T / (2 * this.C3);
    const i1 = (vin - this.vc3 - a3 * this.i1Prev) / (this.R3 + a3);
    this.vc3 += a3 * (i1 + this.i1Prev);
    this.i1Prev = i1;
    const vg = vin + this.Rdist * i1;

    // 2) LM308 摆率软化(5.3kHz 双线性一阶低通)
    const v2 = this.slewA0 * (vg + this.slewX1) - this.slewB1 * this.slewY1;
    this.slewX1 = vg;
    this.slewY1 = v2;

    // 3) Newton 解削波节点 Vd(FILTER 支路作为线性负载联立)
    const { Is, nVt } = this.diode;
    const gf = 1 / (this.Rfilt + this.a6);
    const gSum = this.G5 + gf;
    // iFilt(Vd) = gf·Vd - known6;known6 由上一本状态决定,迭代中不变
    const known6 = (this.vc6 + this.a6 * this.iFiltPrev) * gf;
    const c5 = v2 * this.G5;
    let vd = this.vdPrev;
    let iter = 0;
    for (; iter < MAX_ITER; iter++) {
      const f = vd * gSum - c5 - known6 + 2 * Is * Math.sinh(vd / nVt);
      if (Math.abs(f) < TOL) break;
      const df = gSum + ((2 * Is) / nVt) * Math.cosh(vd / nVt);
      let step = f / df;
      const maxStep = 0.2;
      if (step > maxStep) step = maxStep;
      else if (step < -maxStep) step = -maxStep;
      vd -= step;
      if (vd > VD_CLAMP) vd = VD_CLAMP;
      else if (vd < -VD_CLAMP) vd = -VD_CLAMP;
    }
    this.iterTotal += iter;
    this.iterCount++;
    this.vdPrev = vd;

    // 4) 更新 C6:iF = gf·Vd - known6; vc6[n] = vc6[n-1] + a6·(iF[n]+iF[n-1])
    const iF = gf * vd - known6;
    this.vc6 += this.a6 * (iF + this.iFiltPrev);
    this.iFiltPrev = iF;

    return this.vc6;
  }
}
