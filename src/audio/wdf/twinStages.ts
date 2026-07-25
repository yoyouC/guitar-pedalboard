/**
 * WDF Twin Reverb 专用电子管级(TS 参考实现,Node 可测)。
 * 与 triode.ts 的 TriodeStage 同构,两处差异:
 *
 * 1) 栅流钳位用真正的隐式 Newton(解 vg = vgSrc - Rs·ig(vg-vk),G 单调)。
 *    TriodeStage 的阻尼定点迭代在 vgk > ~0.85V 时因 ig 饱和(指数截断 e^20)
 *    会跳到数万伏的伪解,把电子管整个关断——大激励下产生 >100% THD 的
 *    开关式极限环。清音箱头需要把后级推入真正的栅流压缩区,必须修。
 *    小信号下 vgSrc < vk,Newton 直接返回 vgSrc,与 TriodeStage 结果一致。
 * 2) 支持 cathodeTap(输出取自阴极)+ Vbias(栅极 DC 偏置),用于 Fender
 *    AB763 的阴极跟随器(板极直连 B+,Rk 到地,栅极坐在前级板压上)。
 *    CF 用偏冷一点的静态(Vbias=95,vgk_q≈-1V)补偿 Koren 模型在低 Vpk
 *    区电流偏弱的问题,使跟随窗 ≈ ±90V(真实 CF 在 Twin 里基本透明)。
 *
 * 外层 Newton 在电流域解 ip,步长钳制 min(5mA, 25V/Rkk) 并带回溯线搜索
 * (Rk=100k 的 CF 若沿用 5mA 钳制,一步就是 500V,会越过 koren 悬崖振荡)。
 *
 * worklet(twinWorklet.ts)内联同一份 JS——改动必须两边同步。
 */
import { KOREN_EL34_APPROX, type KorenParams } from './triode.ts';

/** 6L6 功率管的近似 Koren 参数:mu≈8.2(按任务书),其余沿用 EL34 行 */
export const KOREN_6L6_APPROX: KorenParams = { ...KOREN_EL34_APPROX, mu: 8.2 };

export interface TwinStageOptions {
  /** 采样率(含过采样倍率后的实际速率) */
  fs: number;
  Bplus?: number;  // 电源电压,默认 300V
  Rp?: number;     // 板极电阻,默认 100k;0 = 板极直连 B+(阴极跟随器)
  Rk?: number;     // 阴极电阻,默认 1.5k
  Ck?: number;     // 阴极旁路电容 F,默认 22uF;0 = 无旁路
  Co?: number;     // 输出耦合电容 F,默认 22nF
  Rload?: number;  // 输出负载,默认 1M
  koren?: KorenParams;
  /** 栅极驱动源内阻(配合栅流钳位),默认 68k */
  Rs?: number;
  /** 栅极 DC 偏置电压(CF 用,默认 0) */
  Vbias?: number;
  /** true = 输出取自阴极(阴极跟随器),默认 false(板极输出) */
  cathodeTap?: boolean;
}

const MAX_ITER = 12;
const TOL = 1e-9;

export class TwinStage {
  private readonly Rp: number;
  private readonly Bplus: number;
  private readonly Rkk: number;
  private readonly Gk: number;
  private readonly Co: number;
  private readonly Rload: number;
  private readonly T: number;
  private readonly koren: KorenParams;
  private readonly Rs: number;
  private readonly Vbias: number;
  private readonly cathodeTap: boolean;
  private readonly maxStep: number;
  private static readonly IG_IS = 1e-9;
  private static readonly IG_NVT = 1.6 * 25.85e-3;

  // 状态
  private iHk = 0;
  private vCkPrev = 0;
  private iCkPrev = 0;
  private vcOut = 0;
  private iOutPrev = 0;
  private ipPrev: number;
  private vgSrc = 0;

  /** Newton 迭代统计(评测用) */
  iterTotal = 0;
  iterCount = 0;

  constructor(opts: TwinStageOptions) {
    this.T = 1 / opts.fs;
    this.Bplus = opts.Bplus ?? 300;
    this.Rp = opts.Rp ?? 100e3;
    const Rk = opts.Rk ?? 1.5e3;
    const Ck = opts.Ck ?? 22e-6;
    this.Co = opts.Co ?? 22e-9;
    this.Rload = opts.Rload ?? 1e6;
    this.koren = opts.koren ?? { mu: 100, ex: 1.4, kg: 1060, kp: 600, kvb: 300 };
    this.Rs = opts.Rs ?? 68e3;
    this.Vbias = opts.Vbias ?? 0;
    this.cathodeTap = opts.cathodeTap ?? false;

    this.Gk = Ck > 0 ? (2 * Ck) / this.T : 0;
    this.Rkk = 1 / (1 / Rk + this.Gk);
    // 步长钳制:每一步 vk 最多走 25V(防止大步长越过 koren 悬崖)
    this.maxStep = Math.min(0.005, 25 / this.Rkk);
    this.ipPrev = this.cathodeTap ? 0.001 : 0.0012;
  }

  private gridCurrent(vgk: number): number {
    if (vgk <= 0) return 0;
    const x = Math.min(vgk / TwinStage.IG_NVT, 30);
    return TwinStage.IG_IS * Math.exp(x);
  }

  /**
   * 栅流钳位(隐式,二分):解 G(vg) = vg - vgSrc + Rs·ig(vg-vk) = 0。
   * G 严格单调且根必在 [vk, vgSrc] 内,二分 20 次把 vgk 压到 ~20µV——
   * 指数二极管会把 vgk 误差放大成板流抖动(Newton 在此欠收敛时
   * 逐样本抖动 ±10%+,表现为传输曲线跳变),故用二分保证收敛深度。
   * 无栅流时(vgSrc ≤ vk)直接返回 vgSrc。
   */
  private solveGrid(vgSrc: number, vk: number): number {
    if (vgSrc <= vk) return vgSrc;
    let lo = vk, hi = vgSrc;
    for (let gi = 0; gi < 20; gi++) {
      const mid = (lo + hi) / 2;
      const f = mid - vgSrc + this.Rs * this.gridCurrent(mid - vk);
      if (f > 0) hi = mid;
      else lo = mid;
    }
    return (lo + hi) / 2;
  }

  /** 处理一个样本。vgIn 为栅极交流电压(V),返回经耦合电容后的输出(V)。 */
  process(vgIn: number): number {
    this.vgSrc = this.Vbias + vgIn;
    this.iHk = this.Gk > 0 ? -this.Gk * this.vCkPrev - this.iCkPrev : 0;

    // Newton 解 ip,带回溯线搜索(|F| 不下降则步长减半,最多 6 次)
    let ip = this.ipPrev;
    let f0 = this.residual(ip);
    for (let iter = 0; iter < MAX_ITER; iter++) {
      this.iterTotal++;
      if (Math.abs(f0) < TOL) break;
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

    // 阴极电压与旁路电容电流,更新电容状态
    const vk = (ip - this.iHk) * this.Rkk;
    const iCk = this.Gk > 0 ? this.Gk * vk + this.iHk : 0;
    this.vCkPrev = vk;
    this.iCkPrev = iCk;

    // 输出节点(板极或阴极)→ 耦合电容 Co → Rload(梯形精确解)
    const vOut = this.cathodeTap ? vk : this.Bplus - ip * this.Rp;
    const a = this.T / (2 * this.Co);
    const vc =
      (this.vcOut + a * (vOut / this.Rload + this.iOutPrev)) / (1 + a / this.Rload);
    const iOut = (vOut - vc) / this.Rload;
    this.vcOut = vc;
    this.iOutPrev = iOut;

    return vOut - vc;
  }

  private residual(ip: number): number {
    const vk = (ip - this.iHk) * this.Rkk;
    const vp = this.Bplus - ip * this.Rp;
    const vg = this.solveGrid(this.vgSrc, vk);
    return ip - korenPlateCurrent(this.koren, vg - vk, vp - vk);
  }
}

/** Koren 板流(与 triode.ts 同式,worklet 内联需同名同逻辑) */
function korenPlateCurrent(p: KorenParams, vgk: number, vpk: number): number {
  if (vpk <= 0) return 0;
  const inner = p.kp * (1 / p.mu + vgk / Math.sqrt(p.kvb + vpk * vpk));
  const softplus = inner > 30 ? inner : Math.log1p(Math.exp(inner));
  const e1 = (vpk / p.kp) * softplus;
  if (e1 <= 0) return 0;
  return Math.pow(e1, p.ex) / p.kg;
}
