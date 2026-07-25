/**
 * WDF AC30(Vox Top Boost 风格,英伦 chime 清音/边缘破音)DSP 核心。
 *
 * 链路(全部非线性级为 Koren 三极管隐式 Newton,线性件梯形/单极点伴随):
 *   输入 → 60Hz 输入耦合 HP → drive(GAIN,幂律行程,低档位清音余量)
 *        → 级1 12AX7 暖偏置(Rk 1.5k + 22µF 全旁路,对称、线性区宽)
 *        → ×A1 → 级2 12AX7 冷一点(Rk 2.7k + 0.68µF 部分旁路,中高频前倾)
 *        → ×A2 → 阴极跟随器(12AX7,Rk 100k,增益≈0.99,过载时不对称软压)
 *        → top-boost 音色(BASS 低频搁架 + MID 峰 + TREBLE 高频搁架 + PRESENCE,
 *          50=平直;搁架之间中频自然突出)——音色在后级之前,推音色会改变破音点
 *        → ×A3 → EL84 后级(A 类热偏置,Koren 近似 mu=19 kp=60 kvb=500,
 *          正半周栅流钳位 sag、负半周宽余量 → 偶次为主的音乐性压缩)
 *        → 输出变压器(75Hz HP + 5.5kHz LP + 2.5kHz 临场峰 chime)
 *        → /NORM 归一化
 *
 * 与 champ/bogner 的差异:音色栈在 worklet 内(后级之前,真实 top-boost 顺序),
 * 且多一个阴极跟随器级。scripts/(wdf-ac30-eval、wdf-ac30-spice-compare)直接用本文件;
 * ac30Worklet.ts 内联同一份 JS——改动请两边同步。
 */
import { KOREN_12AX7, korenPlateCurrent, type KorenParams } from './triode.ts';

/**
 * 共阴极三极管级(与 triode.ts 的 TriodeStage 完全同构,唯一差异:
 * 栅流钳位用**二分法**解单调方程 g(vg)=vg−vgSrc+Rs·ig(vg−vk)=0)。
 *
 * 为什么不用共享的 TriodeStage:其阻尼定点 solveGrid 在 vgSrc−vk > ~0.83V
 * 时被指数栅流(Rs·ig 封顶后仍达数万 V)踹到 −16kV,Koren 板流瞬间归零
 * (板极甩到 B+ 轨),深激励下与耦合电容充放电形成 period-2 极限环
 * (1kHz 输入输出变 2kHz 主导,f1 塌陷,本链 g50/0.3V 曾复现 THD 5920%)。
 * AC30 的音乐性破音区(EL84 栅压 4~8V)正好压在旧实现的翻车阈值上,
 * 故本链全部 Koren 级用此稳健变体;方程(阴极旁路/耦合电容梯形伴随、
 * Newton 主循环)与 triode.ts 逐行一致——TriodeStage 若修正,请同步此处
 * 与 ac30Worklet.ts 内联副本。
 */
export interface WdfTriodeStageOptions {
  fs: number;
  Bplus?: number;
  Rp?: number;
  Rk?: number;
  Ck?: number;
  Co?: number;
  Rload?: number;
  koren?: KorenParams;
  Rs?: number;
  gridClamp?: boolean;
}

export class WdfTriodeStage {
  private readonly Rp: number;
  private readonly Bplus: number;
  private readonly Rkk: number;
  private readonly Gk: number;
  private readonly Co: number;
  private readonly Rload: number;
  private readonly T: number;
  private readonly koren: KorenParams;
  private readonly Rs: number;
  private readonly gridClamp: boolean;
  private static readonly IG_IS = 1e-9;
  private static readonly IG_NVT = 1.6 * 25.85e-3;

  private iHk = 0;
  private vCkPrev = 0;
  private iCkPrev = 0;
  private vcOut = 0;
  private iOutPrev = 0;
  private ipPrev = 0.0012;
  private vgSrc = 0;

  constructor(opts: WdfTriodeStageOptions) {
    this.T = 1 / opts.fs;
    this.Bplus = opts.Bplus ?? 300;
    this.Rp = opts.Rp ?? 100e3;
    const Rk = opts.Rk ?? 1.5e3;
    const Ck = opts.Ck ?? 22e-6;
    this.Co = opts.Co ?? 4.7e-9;
    this.Rload = opts.Rload ?? 1e6;
    this.koren = opts.koren ?? KOREN_12AX7;
    this.Rs = opts.Rs ?? 68e3;
    this.gridClamp = opts.gridClamp ?? true;
    this.Gk = Ck > 0 ? (2 * Ck) / this.T : 0;
    this.Rkk = 1 / (1 / Rk + this.Gk);
  }

  private gridCurrent(vgk: number): number {
    if (vgk <= 0) return 0;
    const x = Math.min(vgk / WdfTriodeStage.IG_NVT, 20);
    return WdfTriodeStage.IG_IS * (Math.exp(x) - 1);
  }

  /** 二分法隐式栅流钳位:g(vk) ≤ 0 ≤ g(vgSrc) 必有根,全局收敛不 overshoot */
  private solveGrid(vgSrc: number, vk: number): number {
    if (!this.gridClamp || vgSrc <= vk) return vgSrc;
    let lo = vk;
    let hi = vgSrc;
    for (let gi = 0; gi < 14; gi++) {
      const mid = 0.5 * (lo + hi);
      const g = mid - vgSrc + this.Rs * this.gridCurrent(mid - vk);
      if (g > 0) hi = mid;
      else lo = mid;
    }
    return 0.5 * (lo + hi);
  }

  /**
   * 板极电压(含耦合网络交流负载的 KCL):(B+−vp)/Rp = ip + (vp−vc)/Rload。
   * TriodeStage 原版是理想驱动(vp = B+−ip·Rp),spice 参考里板极被
   * 耦合电容后的分压/栅漏网络加载(100k∥1M → 每级 −9% 增益,L4 曾实测
   * WDF 系统性偏热 +12%≈1.0dB);vc 为耦合电容电压(样本内是状态常数)。
   * DC 工作点不变(直流下电容开路)。
   */
  private plateVp(ip: number): number {
    const r = this.Rp / this.Rload;
    return (this.Bplus - ip * this.Rp + r * this.vcOut) / (1 + r);
  }

  private residual(ip: number): number {
    const vk = (ip - this.iHk) * this.Rkk;
    const vp = this.plateVp(ip);
    const vg = this.solveGrid(this.vgSrc, vk);
    return ip - korenPlateCurrent(this.koren, vg - vk, vp - vk);
  }

  process(vgIn: number): number {
    this.vgSrc = vgIn;
    this.iHk = this.Gk > 0 ? -this.Gk * this.vCkPrev - this.iCkPrev : 0;
    let ip = this.ipPrev;
    for (let iter = 0; iter < 12; iter++) {
      const f0 = this.residual(ip);
      if (Math.abs(f0) < 1e-9) break;
      const h = Math.max(1e-7, Math.abs(ip) * 1e-5);
      const df = (this.residual(ip + h) - f0) / h;
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
    const vp = this.plateVp(ip);
    const a = this.T / (2 * this.Co);
    const vc =
      (this.vcOut + a * (vp / this.Rload + this.iOutPrev)) / (1 + a / this.Rload);
    const iOut = (vp - vc) / this.Rload;
    this.vcOut = vc;
    this.iOutPrev = iOut;
    return vp - vc;
  }
}

/**
 * EL84 功率管的近似 Koren 参数(经验拟合,介于 12AX7 与 EL34 之间取):
 * mu≈19(五极管接法三极管化等效)、kp≈60、kvb≈500;kg 按 B+=310V / Rp 4k /
 * Rk 150 静态 ~35mA(A 类热偏置)标定(见 scripts/wdf-ac30-eval.ts L1 打印)。
 */
export const KOREN_EL84_APPROX: KorenParams = {
  mu: 19,
  ex: 1.35,
  kg: 210,
  kp: 60,
  kvb: 500,
};

/** 链路网关常数(调参冻结,worklet 内联同一份) */
export const AC30 = {
  /** 输入耦合 HP 转角(Hz) */
  HP_IN: 60,
  /** GAIN 行程:drive = 1 + DRIVE_MAX·(gain/100)^DRIVE_EXP(幂律:低档清音、高档快进破音) */
  DRIVE_MAX: 18,
  DRIVE_EXP: 1.8,
  /** 级间衰减:级1→级2 / 级2→CF / 音色→EL84(含 top-boost 插入损耗) */
  A1: 0.025,
  A2: 0.075,
  A3: 0.8197,
  /** 输出变压器:HP / LP / 临场峰(频率、Q、叠加量) */
  XF_HP: 75,
  XF_LP: 5500,
  CHIME_F: 2500,
  CHIME_Q: 1,
  CHIME_G: 0.45,
  /** 输出归一化(内部"电压"→ 数字电平;满激励峰值 ≈0.6,清音区增益 ≈1) */
  NORM: 100,
  /** top-boost 音色:BASS/MID/TREBLE ±12dB、PRESENCE ±8dB,50=平直 */
  BASS_F: 110,
  MID_F: 800,
  MID_Q: 1,
  TREBLE_F: 3000,
  PRES_F: 5000,
  TONE_DB: 12,
  PRES_DB: 8,
  SHELF_Q: 0.7071,
} as const;

/** GAIN 旋钮(0~100)→ 前级激励倍数 */
export function ac30Drive(gainPct: number): number {
  const g = Math.min(100, Math.max(0, gainPct)) / 100;
  return 1 + AC30.DRIVE_MAX * Math.pow(g, AC30.DRIVE_EXP);
}

/** 音色旋钮(0~100,50=平直)→ dB */
export function ac30ToneDb(v: number, range: number): number {
  return ((Math.min(100, Math.max(0, v)) - 50) / 50) * range;
}

/**
 * 阴极跟随器(cathode follower):板极直连 B+,输出取自阴极。
 * 与 TriodeStage 同宗的隐式 Newton(单变量 F(Ip)=0)+ 隐式栅流钳位,
 * 但阴极无旁路电容、Rk 很大(100k):增益≈0.99、低输出阻抗;
 * 负向余量小(静态 vk 仅几 V),过载时 cutoff 侧先压 → 不对称软压(top-boost 签名之一)。
 */
export class CathodeFollower {
  /** Newton 迭代统计(L0 用) */
  iterTotal = 0;
  iterCount = 0;

  private readonly T: number;
  private readonly Bplus: number;
  private readonly Rk: number;
  private readonly Co: number;
  private readonly Rload: number;
  private readonly Rkk: number; // Rk ∥ Rload(阴极交流负载,见 cathodeVk)
  private readonly koren: KorenParams;
  private readonly Rs: number;
  private readonly gridClamp: boolean;
  private readonly gridBias: number;
  private static readonly IG_IS = 1e-9;
  private static readonly IG_NVT = 1.6 * 25.85e-3;

  private vcOut = 0;
  private iOutPrev = 0;
  private ipPrev: number;
  private vgSrc = 0;

  constructor(opts: {
    fs: number;
    Bplus?: number;
    Rk?: number;
    Co?: number;
    Rload?: number;
    koren?: KorenParams;
    Rs?: number;
    gridClamp?: boolean;
    /**
     * 栅极直流偏置参考(V,默认 0 = 栅漏接地)。真实 top-boost 的 CF
     * 栅漏接高电位(类板极直耦),把阴极静态 vk 抬高 → 负向(cutoff 侧)
     * 余量从几 V 扩到几十 V,CF 在常规激励下近似透明缓冲,只保留
     * ≈0.99 增益与极端正摆的栅流软压;破音主角让给 EL84。
     */
    gridBias?: number;
  }) {
    this.T = 1 / opts.fs;
    this.Bplus = opts.Bplus ?? 300;
    this.Rk = opts.Rk ?? 100e3;
    this.Co = opts.Co ?? 4.7e-9;
    this.Rload = opts.Rload ?? 1e6;
    this.koren = opts.koren ?? KOREN_12AX7;
    this.Rs = opts.Rs ?? 68e3;
    this.gridClamp = opts.gridClamp ?? true;
    this.gridBias = opts.gridBias ?? 0;
    this.Rkk = 1 / (1 / this.Rk + 1 / this.Rload);
    // 初始猜测:静态阴极电流 ≈ (偏置+几 V)/Rk
    this.ipPrev = Math.max(4e-5, this.gridBias / this.Rk);
  }

  /**
   * 阴极电压(含耦合负载的 KCL):ip = vk/Rk + (vk−vc)/Rload
   * → vk = (ip + vc/Rload)·(Rk∥Rload);vc 为耦合电容电压(状态)。
   * DC 稳态自洽:vc=vk → vk = ip·Rk(直流工作点不变)。
   */
  private cathodeVk(ip: number): number {
    return (ip + this.vcOut / this.Rload) * this.Rkk;
  }

  private gridCurrent(vgk: number): number {
    if (vgk <= 0) return 0;
    const x = Math.min(vgk / CathodeFollower.IG_NVT, 20);
    return CathodeFollower.IG_IS * (Math.exp(x) - 1);
  }

  /**
   * 隐式栅流钳位(无状态延迟)。与 TriodeStage 的阻尼定点不同,这里用
   * **二分法**解单调方程 g(vg) = vg − vgSrc + Rs·ig(vg−vk) = 0:
   * CF 栅漏接 +60V 偏置,vgSrc−vk 恒正且很大,阻尼定点会被
   * Rs·ig(指数封顶后仍达 ~0.5A·Rs ≈ 数万 V)一脚踹到 −16kV,
   * Koren 板流归零、ip 锁死在 0(链中曾复现:CF 输出恒 0)。
   * g(vk) ≤ 0 ≤ g(vgSrc) 必有根,二分全局收敛、不 overshoot。
   */
  private solveGrid(vgSrc: number, vk: number): number {
    if (!this.gridClamp || vgSrc <= vk) return vgSrc;
    let lo = vk;
    let hi = vgSrc;
    for (let gi = 0; gi < 14; gi++) {
      const mid = 0.5 * (lo + hi);
      const g = mid - vgSrc + this.Rs * this.gridCurrent(mid - vk);
      if (g > 0) hi = mid;
      else lo = mid;
    }
    return 0.5 * (lo + hi);
  }

  /** F(Ip) = Ip − koren(vg−vk, B+−vk),vk 由 cathodeVk(含负载);栅源 = 信号 + 直流偏置 */
  private residual(ip: number): number {
    const vk = this.cathodeVk(ip);
    const vg = this.solveGrid(this.vgSrc + this.gridBias, vk);
    return ip - korenPlateCurrent(this.koren, vg - vk, this.Bplus - vk);
  }

  /**
   * 外层 Ip 求解:F(ip) 严格单调升(ip 项 +1,koren 随 vk 非增),
   * 用持久括号 + 二分——Rk=100k 使 vk 对 ip 极敏感(Δ1µA→Δ0.1V),
   * 定点 Newton 的步长钳制会在"导通/截止"两盆间来回超调锁死
   * (首样本 +22V 建立瞬态曾复现:ip 在 0 与 1.19mA 间振荡,输出恒 0)。
   * 单调 → 括号 [0, B+/Rk] 内必有根,二分全局收敛;
   * 括号沿用上一样本根附近,常规仅 ~4 次残差求值(比 Newton 还省)。
   */
  process(vgIn: number): number {
    this.vgSrc = vgIn;
    const IP_MAX = this.Bplus / this.Rk;
    // 暖启动紧括号(±2%):CF 电流逐样本漂移 ≪1%,极端摆动由扩展环兜底
    let lo = Math.max(0, this.ipPrev * 0.98 - 1e-9);
    let hi = Math.min(IP_MAX, this.ipPrev * 1.02 + 1e-9);
    this.iterCount++;
    let flo = this.residual(lo);
    let fhi = this.residual(hi);
    // 扩展括号直到夹住变号(信号大幅摆动时)
    for (let g = 0; g < 24 && flo > 0 && lo > 0; g++) {
      hi = lo;
      fhi = flo;
      lo *= 0.5;
      this.iterCount++;
      flo = this.residual(lo);
    }
    for (let g = 0; g < 24 && fhi < 0 && hi < IP_MAX; g++) {
      lo = hi;
      flo = fhi;
      hi = Math.min(IP_MAX, hi * 2 + 1e-6);
      this.iterCount++;
      fhi = this.residual(hi);
    }
    let ip: number;
    if (flo >= 0) {
      ip = lo; // F(0) ≥ 0:截止(含 koren=0 时 F(0)=0 的精确不动点)
    } else if (fhi <= 0) {
      ip = hi; // 到物理上限,兜底
    } else {
      for (let it = 0; it < 8; it++) {
        const mid = 0.5 * (lo + hi);
        this.iterCount++;
        this.iterTotal++;
        if (this.residual(mid) > 0) hi = mid;
        else lo = mid;
      }
      ip = 0.5 * (lo + hi);
      // Newton 抛光:二分只到量化格,逐样本会在相邻格间跳变(vk ±0.03V
      // → 静音本底/混叠底噪),抛到机器精度的不动点消除跳变
      for (let p = 0; p < 2; p++) {
        this.iterCount++;
        const f0 = this.residual(ip);
        if (Math.abs(f0) < 1e-13) break;
        const h = Math.max(1e-10, Math.abs(ip) * 1e-6);
        this.iterCount++;
        const df = (this.residual(ip + h) - f0) / h;
        if (df === 0 || !Number.isFinite(df)) break;
        ip -= f0 / df;
        if (ip < 0) ip = 0;
        else if (ip > IP_MAX) ip = IP_MAX;
      }
    }
    this.ipPrev = ip;

    // 阴极电压(含负载 KCL)→ 耦合电容 Co → Rload(梯形精确解)
    const vk = this.cathodeVk(ip);
    const a = this.T / (2 * this.Co);
    const vc =
      (this.vcOut + a * (vk / this.Rload + this.iOutPrev)) / (1 + a / this.Rload);
    const iOut = (vk - vc) / this.Rload;
    this.vcOut = vc;
    this.iOutPrev = iOut;
    return vk - vc;
  }
}

/** RBJ 双二阶(音色搁架/峰、临场峰带通;0dB 搁架 = 精确直通) */
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  private set(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number) {
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
  }

  private static alpha(fs: number, f: number, q: number) {
    const w0 = (2 * Math.PI * f) / fs;
    return { w0, cs: Math.cos(w0), al: Math.sin(w0) / (2 * q) };
  }

  setLowshelf(fs: number, f: number, db: number, q: number): void {
    const A = Math.pow(10, db / 40);
    const { cs, al } = Biquad.alpha(fs, f, q);
    const sq = 2 * Math.sqrt(A) * al;
    this.set(
      A * (A + 1 - (A - 1) * cs + sq),
      2 * A * (A - 1 - (A + 1) * cs),
      A * (A + 1 - (A - 1) * cs - sq),
      A + 1 + (A - 1) * cs + sq,
      -2 * (A - 1 + (A + 1) * cs),
      A + 1 + (A - 1) * cs - sq,
    );
  }

  setHighshelf(fs: number, f: number, db: number, q: number): void {
    const A = Math.pow(10, db / 40);
    const { cs, al } = Biquad.alpha(fs, f, q);
    const sq = 2 * Math.sqrt(A) * al;
    this.set(
      A * (A + 1 + (A - 1) * cs + sq),
      -2 * A * (A - 1 + (A + 1) * cs),
      A * (A + 1 + (A - 1) * cs - sq),
      A + 1 - (A - 1) * cs + sq,
      2 * (A - 1 - (A + 1) * cs),
      A + 1 - (A - 1) * cs - sq,
    );
  }

  setPeaking(fs: number, f: number, db: number, q: number): void {
    const A = Math.pow(10, db / 40);
    const { cs, al } = Biquad.alpha(fs, f, q);
    this.set(1 + al * A, -2 * cs, 1 - al * A, 1 + al / A, -2 * cs, 1 - al / A);
  }

  /** 带通(峰值增益恒 0dB,与串联 RLC 取 R 上电压同构)——2.5kHz 临场峰用 */
  setBandpass(fs: number, f: number, q: number): void {
    const { cs, al } = Biquad.alpha(fs, f, q);
    this.set(al, 0, -al, 1 + al, -2 * cs, 1 - al);
  }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** 单极点 HP 状态(输入耦合 / 变压器) */
interface HpState {
  x1: number;
  y1: number;
}

/**
 * AC30 全链(过采样域,每通道一个实例)。
 * 音色旋钮块率更新(50=平直 = 精确直通,L4 对照即取全 50)。
 */
export class Ac30Chain {
  /** 末级 CF 的 Newton 统计透传(L0 用) */
  readonly cf: CathodeFollower;
  private readonly st1: WdfTriodeStage;
  private readonly st2: WdfTriodeStage;
  private readonly pw: WdfTriodeStage;
  private readonly fs: number;
  private drive = 1;
  // 输入 HP / 变压器 HP+LP 状态
  private hpIn: HpState = { x1: 0, y1: 0 };
  private xfHp: HpState = { x1: 0, y1: 0 };
  private xfLpY1 = 0;
  private readonly chime = new Biquad();
  private readonly bass = new Biquad();
  private readonly mid = new Biquad();
  private readonly treble = new Biquad();
  private readonly presence = new Biquad();

  constructor(
    fs: number,
    gain = 35,
    bassV = 50,
    midV = 50,
    trebleV = 50,
    presenceV = 50,
  ) {
    this.fs = fs;
    // 级1:暖偏置(全旁路,对称、线性区宽),Rs 68k 栅漏
    this.st1 = new WdfTriodeStage({ fs, Rk: 1.5e3, Ck: 22e-6, Rs: 68e3 });
    // 级2:冷一点(Rk 2.7k + 0.68µF 部分旁路,中高频前倾),Rs = 级间分压戴维南 24.4k
    this.st2 = new WdfTriodeStage({ fs, Rk: 2.7e3, Ck: 0.68e-6, Rs: 24.4e3 });
    // 阴极跟随器:Rk 100k,栅漏偏置 60V(抬静态 vk → 宽负向余量,近似透明缓冲),
    // Rs = 级间分压戴维南 69.4k,负载 = 220k+1M(EL84 栅路)
    this.cf = new CathodeFollower({ fs, Rk: 100e3, Rs: 69.4e3, Rload: 1.22e6, gridBias: 60 });
    // EL84 后级:A 类,B+ 310V,Rp 4k(反射负载),Rk 150 热偏置,Rs = 栅漏 220k;
    // Rload=100k = 输出变压器初级反射交流负载(spice 侧 Ctx→Rtx 100k;
    // Co 1mF 对其透明,DC 静态点不变)
    this.pw = new WdfTriodeStage({
      fs,
      koren: KOREN_EL84_APPROX,
      Bplus: 310,
      Rp: 4e3,
      Rk: 150,
      Ck: 0,
      Co: 1e-3,
      Rload: 100e3,
      Rs: 220e3,
    });
    this.chime.setBandpass(fs, AC30.CHIME_F, AC30.CHIME_Q);
    this.setGain(gain);
    this.setTone(bassV, midV, trebleV, presenceV);
  }

  setGain(gain: number): void {
    this.drive = ac30Drive(gain);
  }

  setTone(bassV: number, midV: number, trebleV: number, presenceV: number): void {
    const fs = this.fs;
    this.bass.setLowshelf(fs, AC30.BASS_F, ac30ToneDb(bassV, AC30.TONE_DB), AC30.SHELF_Q);
    this.mid.setPeaking(fs, AC30.MID_F, ac30ToneDb(midV, AC30.TONE_DB), AC30.MID_Q);
    this.treble.setHighshelf(fs, AC30.TREBLE_F, ac30ToneDb(trebleV, AC30.TONE_DB), AC30.SHELF_Q);
    this.presence.setHighshelf(fs, AC30.PRES_F, ac30ToneDb(presenceV, AC30.PRES_DB), AC30.SHELF_Q);
  }

  private hp(st: HpState, x: number, fc: number): number {
    const T = 1 / this.fs;
    const rc = 1 / (2 * Math.PI * fc);
    const a = rc / (rc + T);
    const y = a * (st.y1 + x - st.x1);
    st.x1 = x;
    st.y1 = y;
    return y;
  }

  /** 处理一个过采样域样本,返回归一化输出 */
  process(x0: number): number {
    const x = this.hp(this.hpIn, x0, AC30.HP_IN);
    const s1 = this.st1.process(x * this.drive);
    const s2 = this.st2.process(s1 * AC30.A1);
    const c = this.cf.process(s2 * AC30.A2);
    const t = this.presence.process(this.treble.process(this.mid.process(this.bass.process(c))));
    const p = this.pw.process(t * AC30.A3);
    const h = this.hp(this.xfHp, p, AC30.XF_HP);
    const T = 1 / this.fs;
    const rcLp = 1 / (2 * Math.PI * AC30.XF_LP);
    const aLp = T / (rcLp + T);
    this.xfLpY1 = this.xfLpY1 + aLp * (h - this.xfLpY1);
    // 临场峰:HP 后取带通叠加(与 spice 串联 RLC 支路同构)
    return (this.xfLpY1 + AC30.CHIME_G * this.chime.process(h)) / AC30.NORM;
  }
}
