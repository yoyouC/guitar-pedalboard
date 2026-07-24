/**
 * WDF 版 Klon Centaur 核心(伴随模型/梯形积分,Node 可测参考实现)。
 * worklet(src/audio/wdf/klonWorklet.ts)内联同一份逻辑——改动请两边同步。
 *
 * 电路(0V 偏置等效,输入缓冲省略):
 *   vin ── 运放增益级(理想线性,g = 10^(knob·46/20),1x~200x)── vo
 *   vo ── Rser(5.6k)──┬── D1(1N34A 锗管)── GND
 *                     ├── D2(反并联)── GND
 *                     └── Rload(27k,求和级湿声输入电阻,虚地负载)── GND
 *   每样本 Newton 解削波节点电压 vd:
 *     F(vd) = (vo-vd)/Rser - vd/Rload - 2·Is·sinh(vd/nVt) = 0(解析 Jacobian)
 *
 *   干湿混合(双联 GAIN 电位器,Klon "透明"感的来源):
 *     干声权重 Wd = Rf2·p/(p·(1-p)·Rpot + RinD),p = 1-knob(B 联反向),
 *     湿声权重 Ww = Rf2/RinW;Rf2 = RinW = RinD = 27k,Rpot = 100k。
 *     sum = Ww·vd + Wd·vin → 3kHz 高架(±10dB,TREBLE)→ LEVEL。
 */

/** 1N34A 类锗二极管参数(文献值:Is≈1µA,nVt≈34mV,Vf≈0.3V) */
export interface GeDiodeParams {
  Is: number;  // 饱和电流 A
  nVt: number; // n·Vt(发射系数 × 热电压)
}

export const DIODE_1N34A: GeDiodeParams = {
  Is: 1e-6,
  nVt: 0.034,
};

const MAX_ITER = 12;
const TOL = 1e-12;
/** 二极管电压钳制(防 sinh 溢出,物理上锗管 Vd 超不过 ±0.5V) */
const VD_CLAMP = 1.0;

/** 锗管反并联对地削波级:运放输出 vo 经 Rser 馈入,vd 为削波节点电压 */
export class KlonClipperStage {
  private readonly Rser: number;
  private readonly Rload: number;
  private readonly diode: GeDiodeParams;

  private vdPrev = 0;

  /** 求解器统计(评测用) */
  iterTotal = 0;
  iterCount = 0;

  constructor(opts?: { Rser?: number; Rload?: number; diode?: GeDiodeParams }) {
    this.Rser = opts?.Rser ?? 5.6e3;
    this.Rload = opts?.Rload ?? 27e3;
    this.diode = opts?.diode ?? DIODE_1N34A;
  }

  /** 输入运放增益级输出 vo,返回削波节点电压 vd */
  process(vo: number): number {
    const { Is, nVt } = this.diode;
    const gLeak = 1 / this.Rser + 1 / this.Rload;
    const iSrc = vo / this.Rser;
    let vd = this.vdPrev;
    let iter = 0;
    for (; iter < MAX_ITER; iter++) {
      const f = 2 * Is * Math.sinh(vd / nVt) + vd * gLeak - iSrc;
      if (Math.abs(f) < TOL) break;
      const df = ((2 * Is) / nVt) * Math.cosh(vd / nVt) + gLeak;
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

/** GAIN 旋钮 0~1 → 运放增益级增益(1x~200x,0~46dB 指数锥度) */
export function klonGainForKnob(knob: number): number {
  const k = Math.min(1, Math.max(0, knob));
  return Math.pow(10, (k * 46) / 20);
}

/**
 * GAIN 旋钮 0~1 → 干声权重(双联电位器 B 联:p = 1-knob 的分压,
 * 源阻抗 p·(1-p)·Rpot 与求和电阻 RinD 的负载效应一并计入)。
 * knob=0 时干声满(Rf2/RinD = 1),knob=1 时干声为 0。
 */
export function klonDryCoeff(knob: number): number {
  const p = 1 - Math.min(1, Math.max(0, knob));
  const Rf2 = 27e3, RinD = 27e3, Rpot = 100e3;
  return (Rf2 * p) / (p * (1 - p) * Rpot + RinD);
}
