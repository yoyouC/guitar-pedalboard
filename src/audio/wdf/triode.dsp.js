/**
 * WDF 共阴极三极管增益级(伴随模型/梯形积分,与双线性 WDF 等效)——单一来源。
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
 * 栅极简化为理想电压驱动 + 隐式二极管栅流钳位(见 solveGrid)。
 *
 * 双模式消费(ADR-0003):worklet 经 `?raw` 取源码字符串拼装 Blob;eval/测试
 * 直接 import。只用单行 import 与内联 export。
 *
 * 权威说明(issue #7 漂移审计,内联版 = 用户实际听到的为准):
 *   - 栅流 nVt 用内联版字面量 0.0414;已删除的 triode.ts 用 1.6*25.85e-3
 *     (= 0.04136,注释称与 spice DGRID 一致)。~0.1% 差异,是否修正待维护者
 *     裁定(见 docs/wdf-drift-audit.md 例外清单);
 *   - 无 gridClamp 开关(triode.ts 有、默认 true,与内联版恒开行为等价);
 *   - 去掉内联版死状态 vkPrev(只写不读)。
 * 另含 AC30 有意分叉的 WdfTriodeStage 变体(第二个导出类,见类注释)。
 */

/**
 * Koren 三极管模型参数
 * @typedef {{ mu: number, ex: number, kg: number, kp: number, kvb: number }} KorenParams
 */

/** Koren 三极管模型参数(12AX7,源自 Koren 1996 / Pakarinen 论文) */
export const KOREN_12AX7 = { mu: 100, ex: 1.4, kg: 1060, kp: 600, kvb: 300 };

/**
 * 6V6 功率管的近似 Koren 参数(调音用经验拟合,非 datasheet 精确值):
 * 低 mu、宽线性区,用于单端后级。
 */
export const KOREN_6V6_APPROX = { mu: 9.7, ex: 1.35, kg: 1030, kp: 48, kvb: 1200 };

/** EL34 功率管的近似 Koren 参数(经验拟合):比 6V6 略高 mu、更早的膝点 */
export const KOREN_EL34_APPROX = { mu: 11, ex: 1.35, kg: 1030, kp: 42, kvb: 1200 };

/**
 * Koren 板流方程,Vgk/Vpk 单位 V,返回 A
 * @param {KorenParams} p
 */
export function korenPlateCurrent(p, vgk, vpk) {
  if (vpk <= 0) return 0;
  const inner = p.kp * (1 / p.mu + vgk / Math.sqrt(p.kvb + vpk * vpk));
  // ln(1+e^x) 的稳定形式
  const softplus = inner > 30 ? inner : Math.log1p(Math.exp(inner));
  const e1 = (vpk / p.kp) * softplus;
  if (e1 <= 0) return 0;
  return Math.pow(e1, p.ex) / p.kg;
}

/**
 * TriodeStage 选项
 * @typedef {object} TriodeStageOptions
 * @property {number} [Bplus] 电源电压,默认 300V
 * @property {number} [Rp]    板极电阻,默认 100k
 * @property {number} [Rk]    阴极电阻,默认 1.5k
 * @property {number} [Ck]    阴极旁路电容 F,默认 22uF;0 = 无旁路
 * @property {number} [Co]    输出耦合电容 F,默认 4.7nF(抬高耦合转角抑制 motorboating)
 * @property {number} [Rload] 输出负载,默认 1M
 * @property {KorenParams} [koren]
 * @property {number} [Rs]    栅极驱动源内阻(栅漏/上级阻抗),默认 68k;配合栅流钳位
 */

const MAX_ITER = 12;
const TOL = 1e-9;

export class TriodeStage {
  /**
   * @param {number} fs 采样率(含过采样倍率后的实际速率)
   * @param {TriodeStageOptions} [opts]
   */
  constructor(fs, opts = {}) {
    this.T = 1 / fs;
    this.Bplus = opts.Bplus ?? 300;
    this.Rp = opts.Rp ?? 100e3;
    const Rk = opts.Rk ?? 1.5e3;
    const Ck = opts.Ck ?? 22e-6;
    this.Co = opts.Co ?? 4.7e-9;
    this.Rload = opts.Rload ?? 1e6;
    this.koren = opts.koren ?? KOREN_12AX7;
    this.Rs = opts.Rs ?? 68e3;
    this.Gk = Ck > 0 ? (2 * Ck) / this.T : 0;
    this.Rkk = 1 / (1 / Rk + this.Gk);
    this.vCkPrev = 0;
    this.iCkPrev = 0;
    this.iHk = 0;
    this.vcOut = 0; // 输出耦合电容电压
    this.iOutPrev = 0;
    this.ipPrev = 0.0012; // 初始猜测:~1.2mA 静态点
    this.vgSrc = 0; // 当前样本的栅极源电压(residual 内联栅流用)
  }

  /**
   * 栅流钳位(隐式):给定源电压与当前阴极电压,定点迭代解
   * vg = vgSrc - Rs·ig(vg - vk)。在 Newton 内部对每次候选 ip 调用,
   * 消除状态延迟——延迟版本会在高激励下产生极限环(非谐波噪声)。
   * 二极管式栅流:ig = Is·(e^(vgk/nVt) - 1),vgk ≤ 0 时为 0。
   */
  solveGrid(vgSrc, vk) {
    let vg = vgSrc;
    for (let gi = 0; gi < 4; gi++) {
      const vgk = vg - vk;
      if (vgk <= 0) break;
      const x = Math.min(vgk / 0.0414, 20); // 防 exp 溢出
      const ig = 1e-9 * (Math.exp(x) - 1);
      if (ig < 1e-12) break;
      const vgNew = vgSrc - this.Rs * ig;
      // 阻尼半步,防大步长振荡
      const next = vg + (vgNew - vg) * 0.5;
      if (Math.abs(next - vg) < 1e-5) {
        vg = next;
        break;
      }
      vg = next;
    }
    return vg;
  }

  residual(ip) {
    const vk = (ip - this.iHk) * this.Rkk;
    const vp = this.Bplus - ip * this.Rp;
    // 隐式栅流:栅压随阴极电压即时变化,无状态延迟
    const vg = this.solveGrid(this.vgSrc, vk);
    return ip - korenPlateCurrent(this.koren, vg - vk, vp - vk);
  }

  /**
   * 处理一个样本。vg 为栅极电压(V,小信号吉他电平),
   * 返回经耦合电容后的输出电压(V)。
   */
  process(vgIn) {
    this.vgSrc = vgIn;
    // 步骤开始:由上一状态推出电容历史电流 Ih = -Gc·v[n-1] - i[n-1]
    this.iHk = this.Gk > 0 ? -this.Gk * this.vCkPrev - this.iCkPrev : 0;

    // Newton 解 Ip:F(Ip) = Ip - f(vg(Vk(Ip)) - Vk(Ip), B+ - Ip·Rp - Vk(Ip)) = 0
    let ip = this.ipPrev;
    for (let iter = 0; iter < MAX_ITER; iter++) {
      const f0 = this.residual(ip);
      if (Math.abs(f0) < TOL) break;
      // 数值 Jacobian(步长按电流尺度取)
      const h = Math.max(1e-7, Math.abs(ip) * 1e-5);
      const df = (this.residual(ip + h) - f0) / h;
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
}

/**
 * AC30 有意分叉的三极管变体(与 TriodeStage 完全同构,差异仅在两处):
 *   1. 栅流钳位用**二分法**解单调方程 g(vg)=vg−vgSrc+Rs·ig(vg−vk)=0;
 *   2. 板极电压含耦合网络交流负载的 KCL(plateVp)。
 *
 * 为什么不用标准的 TriodeStage:其阻尼定点 solveGrid 在 vgSrc−vk > ~0.83V
 * 时被指数栅流(Rs·ig 封顶后仍达数万 V)踹到 −16kV,Koren 板流瞬间归零
 * (板极甩到 B+ 轨),深激励下与耦合电容充放电形成 period-2 极限环
 * (1kHz 输入输出变 2kHz 主导,f1 塌陷,AC30 链 g50/0.3V 曾复现 THD 5920%)。
 * AC30 的音乐性破音区(EL84 栅压 4~8V)正好压在该翻车阈值上,故 AC30 全链
 * Koren 级用此稳健变体。plateVp:spice 参考里板极被耦合电容后的分压/栅漏
 * 网络加载(100k∥1M → 每级 −9% 增益,L4 曾实测 WDF 系统性偏热 +12%≈1.0dB);
 * vc 为耦合电容电压(样本内是状态常数),DC 工作点不变(直流下电容开路)。
 * 两个三极管实现同住本文件:修 TriodeStage 的求解器时,一眼对照本类评估
 * 是否同样适用(issue #7 用户故事 13)。
 */
export class WdfTriodeStage {
  /**
   * @param {number} fs 采样率(含过采样倍率后的实际速率)
   * @param {TriodeStageOptions} [opts]
   */
  constructor(fs, opts = {}) {
    this.T = 1 / fs;
    this.Bplus = opts.Bplus ?? 300;
    this.Rp = opts.Rp ?? 100e3;
    const Rk = opts.Rk ?? 1.5e3;
    const Ck = opts.Ck ?? 22e-6;
    this.Co = opts.Co ?? 4.7e-9;
    this.Rload = opts.Rload ?? 1e6;
    this.koren = opts.koren ?? KOREN_12AX7;
    this.Rs = opts.Rs ?? 68e3;
    this.Gk = Ck > 0 ? (2 * Ck) / this.T : 0;
    this.Rkk = 1 / (1 / Rk + this.Gk);
    this.vCkPrev = 0;
    this.iCkPrev = 0;
    this.iHk = 0;
    this.vcOut = 0;
    this.iOutPrev = 0;
    this.ipPrev = 0.0012;
    this.vgSrc = 0;
  }

  /** 二分法隐式栅流钳位:g(vk) ≤ 0 ≤ g(vgSrc) 必有根,全局收敛不 overshoot */
  solveGrid(vgSrc, vk) {
    if (vgSrc <= vk) return vgSrc;
    let lo = vk;
    let hi = vgSrc;
    for (let gi = 0; gi < 14; gi++) {
      const mid = 0.5 * (lo + hi);
      const x = Math.min((mid - vk) / 0.0414, 20);
      const ig = 1e-9 * (Math.exp(x) - 1);
      const g = mid - vgSrc + this.Rs * ig;
      if (g > 0) hi = mid;
      else lo = mid;
    }
    return 0.5 * (lo + hi);
  }

  /**
   * 板极电压(含耦合网络交流负载的 KCL):(B+−vp)/Rp = ip + (vp−vc)/Rload。
   * TriodeStage 原版是理想驱动(vp = B+−ip·Rp)。
   */
  plateVp(ip) {
    const r = this.Rp / this.Rload;
    return (this.Bplus - ip * this.Rp + r * this.vcOut) / (1 + r);
  }

  residual(ip) {
    const vk = (ip - this.iHk) * this.Rkk;
    const vp = this.plateVp(ip);
    const vg = this.solveGrid(this.vgSrc, vk);
    return ip - korenPlateCurrent(this.koren, vg - vk, vp - vk);
  }

  process(vgIn) {
    this.vgSrc = vgIn;
    this.iHk = this.Gk > 0 ? -this.Gk * this.vCkPrev - this.iCkPrev : 0;
    let ip = this.ipPrev;
    for (let iter = 0; iter < MAX_ITER; iter++) {
      const f0 = this.residual(ip);
      if (Math.abs(f0) < TOL) break;
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
