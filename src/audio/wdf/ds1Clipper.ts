/**
 * WDF 版 Boss DS-1 核心级(运放可变增益 + 1N4148 反并联对地削波,伴随模型/梯形积分)。
 *
 * 电路(元件值按 ElectroSmash DS-1 分析):
 *   运放同相可变增益级(理想化 V- = Vin):
 *     (-) ── R12(4.7k)── C8(0.47uF)── GND   → 72Hz 高通支路 Z1
 *     反馈:Vout ── Rf || C7 ── V-  → Rf = R13(2.2k) + DIST(0~100k),
 *       C7(100pF) → 反馈低通随 DIST 移动(723kHz → 15.6kHz)
 *       中频增益 = 1 + Rf/R12 ≈ 1.47 ~ 22.7
 *   削波:Vout ── R17(2.2k)──┬── D1/D2(1N4148 反并联)── GND
 *                         └── Rload(4.7k,音色网络等效中频负载)── GND
 *
 * 与 TS808 的结构差异:二极管在输出节点对地(硬削波),而非反馈回路内,
 * 因此削波节点是"软"节点,负载电流进入 Newton 方程。
 *
 * 每样本:
 *   1) Z1 支路电流 i1(线性,梯形精确解)
 *   2) 反馈电压 vf = (i1 - ih7) / (1/Rf + G7)(线性),vOp = vin + vf
 *   3) Newton 解削波节点 vd:F(vd) = 2·Is·sinh(vd/nVt) + vd·(1/R17+1/Rload) - vOp/R17
 *      解析 Jacobian、步长阻尼、初值沿用上一样本
 *
 * 前级 BJT booster 简化为固定增益 5 + Vsat=2V tanh 温和软削(见 worklet/eval 链),
 * 音色级为 LP(723Hz)/HP(7.2kHz)交叉淡化,均在本级之外。
 */

/** 1N4148 二极管参数(WDF 文献标准值:chowdsp / Yeh 论文,与 diodeClipper.ts 一致) */
export interface DiodeParams {
  Is: number;  // 饱和电流 A
  nVt: number; // n·Vt(发射系数 × 热电压)
}

export const DIODE_1N4148: DiodeParams = {
  Is: 2.52e-9,
  nVt: 1.752 * 25.85e-3,
};

export interface Ds1ClipperOptions {
  /** 采样率(含过采样倍率后的实际速率) */
  fs: number;
  diode?: DiodeParams;
}

const MAX_ITER = 12;
const TOL = 1e-12;
/** 二极管电压钳制(防 sinh 溢出,物理上 vd 超不过 ±0.9V) */
const VD_CLAMP = 1.0;

export class Ds1ClipperStage {
  private readonly T: number;
  private readonly R12 = 4.7e3;
  private readonly C8 = 0.47e-6;
  private readonly G7: number; // C7(100pF)伴随电导
  private readonly diode: DiodeParams;

  /** 反馈电阻(R13 2.2k + 100k·dist),setDist 设置 */
  private Rf = 2.2e3 + 50e3;

  /** 削波节点:源内阻 R17 与音色网络等效负载 Rload */
  private readonly G17 = 1 / 2.2e3;
  private readonly Gload = 1 / 4.7e3;

  // 状态
  private vc8 = 0;   // C8 电容电压
  private i1Prev = 0;
  private ih7 = 0;   // C7 历史电流
  private vdPrev = 0;

  /** 求解器统计(评测用) */
  iterTotal = 0;
  iterCount = 0;

  constructor(opts: Ds1ClipperOptions) {
    this.T = 1 / opts.fs;
    this.G7 = (2 * 100e-12) / this.T;
    this.diode = opts.diode ?? DIODE_1N4148;
  }

  /** dist 0~1 → Rf = 2.2k + 100k·dist(DS-1 中频增益 1+Rf/R12 ≈ 1.47~22.7) */
  setDist(dist: number): void {
    this.Rf = 2.2e3 + 100e3 * Math.min(1, Math.max(0, dist));
  }

  /** vBst:BJT 前级输出(链内已做固定增益+tanh 软削)。返回削波节点电压。 */
  process(vBst: number): number {
    // 1) Z1 支路电流(串联 R12-C8,梯形):
    //    vBst = i1·R12 + vc8, vc8[n] = vc8[n-1] + a·(i1[n]+i1[n-1])
    const a = this.T / (2 * this.C8);
    const i1 = (vBst - this.vc8 - a * this.i1Prev) / (this.R12 + a);
    this.vc8 += a * (i1 + this.i1Prev);
    this.i1Prev = i1;

    // 2) 反馈网络(Rf || C7,线性):vf = (i1 - ih7) / (1/Rf + G7)
    const gZf = 1 / this.Rf + this.G7;
    const vf = (i1 - this.ih7) / gZf;
    const iC7 = this.G7 * vf + this.ih7;
    this.ih7 = -this.G7 * vf - iC7;
    const vOp = vBst + vf;

    // 3) Newton 解削波节点:F(vd) = Id(vd) + vd·(G17+Gload) - vOp·G17
    const { Is, nVt } = this.diode;
    const gSum = this.G17 + this.Gload;
    const src = vOp * this.G17;
    let vd = this.vdPrev;
    let iter = 0;
    for (; iter < MAX_ITER; iter++) {
      const f = 2 * Is * Math.sinh(vd / nVt) + vd * gSum - src;
      if (Math.abs(f) < TOL) break;
      const df = ((2 * Is) / nVt) * Math.cosh(vd / nVt) + gSum;
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

    return vd;
  }
}
