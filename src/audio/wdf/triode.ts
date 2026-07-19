/**
 * WDF 共阴极三极管增益级(伴随模型/梯形积分,与双线性 WDF 等效)。
 *
 * 电路(经典 12AX7 共阴极级):
 *   B+ ── Rp ──┬── 板极
 *              │  三极管(Koren 静态模型, Ip=f(Vgk,Vpk))
 *   栅极 vg ───┤
 *              └── 阴极 ── Rk ── GND
 *                   └──── Ck(阴极旁路电容)── GND
 *   板极 ── Co(耦合电容)── 输出 ── Rload ── GND
 *
 * 每个样本用 Newton 迭代解单变量非线性方程 F(Ip)=0:
 *   板极:   Vp = B+ - Ip·Rp
 *   阴极:   Vk = (Ip - Ih)·Rkk,  Rkk = 1/(1/Rk + Gk)
 *   电容:   梯形伴随模型 Gc = 2C/T,历史电流 Ih(等价 WDF 中 b[n]=a[n-1])
 * 栅极简化为理想电压驱动(不取栅流,V1 版;栅流钳位留待后续)。
 */

/** Koren 三极管模型参数(12AX7,源自 Koren 1996 / Pakarinen 论文) */
export interface KorenParams {
  mu: number;
  ex: number;
  kg: number;
  kp: number;
  kvb: number;
}

export const KOREN_12AX7: KorenParams = {
  mu: 100,
  ex: 1.4,
  kg: 1060,
  kp: 600,
  kvb: 300,
};

/**
 * 6V6 功率管的近似 Koren 参数(调音用经验拟合,非 datasheet 精确值):
 * 低 mu、宽线性区,用于单端后级。
 */
export const KOREN_6V6_APPROX: KorenParams = {
  mu: 9.7,
  ex: 1.35,
  kg: 1030,
  kp: 48,
  kvb: 1200,
};

/** Koren 板流方程,Vgk/Vpk 单位 V,返回 A */
export function korenPlateCurrent(p: KorenParams, vgk: number, vpk: number): number {
  if (vpk <= 0) return 0;
  const inner = p.kp * (1 / p.mu + vgk / Math.sqrt(p.kvb + vpk * vpk));
  // ln(1+e^x) 的稳定形式
  const softplus = inner > 30 ? inner : Math.log1p(Math.exp(inner));
  const e1 = (vpk / p.kp) * softplus;
  if (e1 <= 0) return 0;
  return Math.pow(e1, p.ex) / p.kg;
}

export interface TriodeStageOptions {
  /** 采样率(含过采样倍率后的实际速率) */
  fs: number;
  Bplus?: number;  // 电源电压,默认 300V
  Rp?: number;     // 板极电阻,默认 100k
  Rk?: number;     // 阴极电阻,默认 1.5k
  Ck?: number;     // 阴极旁路电容 F,默认 22uF;0 = 无旁路
  Co?: number;     // 输出耦合电容 F,默认 22nF
  Rload?: number;  // 输出负载,默认 1M
  koren?: KorenParams;
  /** 栅极驱动源内阻(栅漏/上级阻抗),默认 68k;配合栅流钳位 */
  Rs?: number;
  /** 是否启用栅流钳位(Vgk>0.7V 时栅极导通),默认 true */
  gridClamp?: boolean;
}

const MAX_ITER = 12;
const TOL = 1e-9;

export class TriodeStage {
  private readonly Rp: number;
  private readonly Bplus: number;
  private readonly Rkk: number; // 阴极对地等效电阻(含旁路电容伴随电导)
  private readonly Gk: number;
  private readonly Co: number;
  private readonly Rload: number;
  private readonly T: number;
  private readonly koren: KorenParams;
  private readonly Rs: number;
  private readonly gridClamp: boolean;
  /** 栅极导通等效正向电阻 */
  private static readonly R_GRID = 1000;
  /** 栅极导通阈值 */
  private static readonly V_GRID_ON = 0.7;

  // 状态
  private iHk = 0;   // 阴极电容历史电流(梯形伴随)
  private vCkPrev = 0;
  private iCkPrev = 0;
  private vkPrev = 0; // 上一样本阴极电压(栅流钳位用,一样本延迟可接受)
  private vcOut = 0; // 输出耦合电容电压
  private iOutPrev = 0;
  private ipPrev = 0.0012; // 初始猜测:~1.2mA 静态点

  constructor(opts: TriodeStageOptions) {
    this.T = 1 / opts.fs;
    this.Bplus = opts.Bplus ?? 300;
    this.Rp = opts.Rp ?? 100e3;
    const Rk = opts.Rk ?? 1.5e3;
    const Ck = opts.Ck ?? 22e-6;
    this.Co = opts.Co ?? 22e-9;
    this.Rload = opts.Rload ?? 1e6;
    this.koren = opts.koren ?? KOREN_12AX7;
    this.Rs = opts.Rs ?? 68e3;
    this.gridClamp = opts.gridClamp ?? true;

    this.Gk = Ck > 0 ? (2 * Ck) / this.T : 0;
    this.Rkk = 1 / (1 / Rk + this.Gk);
  }

  /**
   * 栅流钳位:Vgk 超过约 0.7V 时栅极开始导通,
   * 栅压被源内阻 Rs 与导通电阻 R_GRID 分压钳住——
   * 这是电子管过载"温暖钳位"的主要来源之一。
   */
  private clampGrid(vg: number): number {
    if (!this.gridClamp) return vg;
    const vgk = vg - this.vkPrev;
    if (vgk <= TriodeStage.V_GRID_ON) return vg;
    const rOn = TriodeStage.R_GRID;
    const vOn = this.vkPrev + TriodeStage.V_GRID_ON;
    return (vg / this.Rs + vOn / rOn) / (1 / this.Rs + 1 / rOn);
  }

  /**
   * 处理一个样本。vg 为栅极电压(V,小信号吉他电平),
   * 返回经耦合电容后的输出电压(V)。
   */
  process(vgIn: number): number {
    // 栅流钳位(基于上一样本阴极电压)
    const vg = this.clampGrid(vgIn);
    // 步骤开始:由上一状态推出电容历史电流 Ih = -Gc·v[n-1] - i[n-1]
    this.iHk = this.Gk > 0 ? -this.Gk * this.vCkPrev - this.iCkPrev : 0;

    // Newton 解 Ip:F(Ip) = Ip - f(vg - Vk(Ip), B+ - Ip·Rp - Vk(Ip)) = 0
    let ip = this.ipPrev;
    for (let iter = 0; iter < MAX_ITER; iter++) {
      const f0 = this.residual(vg, ip);
      if (Math.abs(f0) < TOL) break;
      // 数值 Jacobian(步长按电流尺度取)
      const h = Math.max(1e-7, Math.abs(ip) * 1e-5);
      const df = (this.residual(vg, ip + h) - f0) / h;
      if (df === 0 || !Number.isFinite(df)) break;
      // 阻尼步进,防止大步长发散
      let step = f0 / df;
      const maxStep = 0.005;
      if (step > maxStep) step = maxStep;
      else if (step < -maxStep) step = -maxStep;
      ip -= step;
      if (ip < 0) ip = 0;
    }
    this.ipPrev = ip;

    // 阴极电压与旁路电容电流,更新电容状态
    const vk = (ip - this.iHk) * this.Rkk;
    const iCk = this.Gk > 0 ? this.Gk * vk + this.iHk : 0;
    this.vCkPrev = vk;
    this.iCkPrev = iCk;
    this.vkPrev = vk;

    // 板极电压 → 耦合电容 Co → Rload(理想电压源驱动的线性 RC,梯形精确解)
    const vp = this.Bplus - ip * this.Rp;
    // vcOut 微分:i = (vp - vcOut)/Rload = C·dvc/dt,梯形离散:
    // vc[n] = vc[n-1] + T/(2C)·(i[n] + i[n-1]), i[n] = (vp[n] - vc[n])/Rload
    const a = this.T / (2 * this.Co);
    const vc =
      (this.vcOut + a * (vp / this.Rload + this.iOutPrev)) / (1 + a / this.Rload);
    const iOut = (vp - vc) / this.Rload;
    this.vcOut = vc;
    this.iOutPrev = iOut;

    return vp - vc;
  }

  private residual(vg: number, ip: number): number {
    const vk = (ip - this.iHk) * this.Rkk;
    const vp = this.Bplus - ip * this.Rp;
    return ip - korenPlateCurrent(this.koren, vg - vk, vp - vk);
  }
}
