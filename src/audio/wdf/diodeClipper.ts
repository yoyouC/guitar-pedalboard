/**
 * WDF 版 TS808 削波级(运放 + 反馈二极管对,伴随模型/梯形积分)。
 *
 * 电路(同相运放,理想化 V- = Vin):
 *   (-) ── R4(4.7k)── C3(0.047uF)── GND   → 720Hz 高通支路 Z1
 *   反馈:Vout ──┬── 二极管对(1N4148 反并联)──┬── V-
 *              ├── 51pF(C4)              ──┤
 *              └── 51k + 500k·DRIVE(Rf)  ──┘
 *
 * 每样本:
 *   1) Z1 支路电流 i1(线性,梯形精确解,与 Vd 无关)
 *   2) Newton 解 Vd:F(Vd) = Id(Vd) + Vd/Rf + iC4(Vd) - i1 = 0
 *      反并联二极管对 Id(Vd) = 2·Is·sinh(Vd/(n·Vt)),解析 Jacobian
 *   3) Vout = Vin + Vd
 */

/** 1N4148 二极管参数(WDF 文献标准值:chowdsp / Yeh 论文) */
export interface DiodeParams {
  Is: number;  // 饱和电流 A
  nVt: number; // n·Vt(发射系数 × 热电压)
}

export const DIODE_1N4148: DiodeParams = {
  Is: 2.52e-9,
  nVt: 1.752 * 25.85e-3,
};

export interface TsClipperOptions {
  /** 采样率(含过采样倍率后的实际速率) */
  fs: number;
  R4?: number;   // Z1 电阻,默认 4.7k
  C3?: number;   // Z1 串联电容,默认 0.047uF(→ 720Hz)
  C4?: number;   // 反馈并联电容,默认 51pF
  diode?: DiodeParams;
}

const MAX_ITER = 12;
const TOL = 1e-12;
/** 二极管电压钳制(防 sinh 溢出,物理上 Vd 超不过 ±0.9V) */
const VD_CLAMP = 1.0;

export class TsClipperStage {
  private readonly T: number;
  private readonly R4: number;
  private readonly C3: number;
  private readonly G4: number; // C4 伴随电导
  private readonly diode: DiodeParams;

  /** 反馈电阻(51k + 500k·drive),setDrive 设置 */
  private Rf = 51e3 + 250e3;

  // 状态
  private vc3 = 0;   // C3 电容电压
  private i1Prev = 0;
  private ih4 = 0;   // C4 历史电流
  private vdPrev = 0;

  /** 求解器统计(评测用) */
  iterTotal = 0;
  iterCount = 0;

  constructor(opts: TsClipperOptions) {
    this.T = 1 / opts.fs;
    this.R4 = opts.R4 ?? 4.7e3;
    this.C3 = opts.C3 ?? 0.047e-6;
    const C4 = opts.C4 ?? 51e-12;
    this.G4 = (2 * C4) / this.T;
    this.diode = opts.diode ?? DIODE_1N4148;
  }

  /** drive 0~1 → Rf = 51k + 500k·drive(TS 增益 1+Zf/Z1 ≈ 12~118) */
  setDrive(drive: number): void {
    this.Rf = 51e3 + 500e3 * Math.min(1, Math.max(0, drive));
  }

  process(vin: number): number {
    // 1) Z1 支路电流(串联 R4-C3,梯形):
    //    vin = i1·R4 + vc3, vc3[n] = vc3[n-1] + a·(i1[n]+i1[n-1])
    const a = this.T / (2 * this.C3);
    const i1 = (vin - this.vc3 - a * this.i1Prev) / (this.R4 + a);
    this.vc3 += a * (i1 + this.i1Prev);
    this.i1Prev = i1;

    // 2) Newton 解 Vd
    const { Is, nVt } = this.diode;
    const gSum = 1 / this.Rf + this.G4;
    let vd = this.vdPrev;
    let iter = 0;
    for (; iter < MAX_ITER; iter++) {
      const f = 2 * Is * Math.sinh(vd / nVt) + vd * gSum + this.ih4 - i1;
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

    // 3) 更新 C4 历史:iC4 = G4·Vd + ih4; 下一步 ih4' = -G4·Vd - iC4
    const iC4 = this.G4 * vd + this.ih4;
    this.ih4 = -this.G4 * vd - iC4;

    return vin + vd;
  }
}
