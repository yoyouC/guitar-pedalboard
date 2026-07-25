/**
 * LA-2A 风格光学压缩核心(纯 TS,Node 可测)。
 *
 * 白盒依据(Teletronix LA-2A 公开电路与 T4B 光电池实测文献):
 * - 侧链峰值检测,宽软拐点 + 随电平渐变的有效比率(LDR 对数特性的宏观表现),
 *   Compress ≈ 3:1,Limit ≈ 10:1。
 * - T4B 增益缩减元件 = EL 面板 + CdS 光敏电阻。CdS 有两类陷阱中心:
 *   快分量(短瞬态后 ~50-70ms 恢复)与"光记忆"慢分量(持续受照后
 *   电阻粘滞,先随快分量回落一半,余尾 1~2s 缓慢消退)。
 *
 * 离散模型(dB 域一阶包络,线性系统速率,无需过采样):
 *   env    = peakHold(|x|, τ_rel=5ms)          峰值包络(整流+面板级平滑)
 *   envDb  = 20·log10(env)
 *   gr     = softKnee(envDb - T, R, W=15dB)    静态增益缩减(宽软拐点)
 *   fast  ← gr   (τ_atk=10ms / τ_rel=60ms)     EL 面板 + LDR 快分量
 *   slow  ← 0.5·gr (τ_atk=250ms / τ_rel=1.3s)  LDR 光记忆分量(半深度)
 *   grDb   = max(fast, slow)                   短音:fast 主导,释放快;
 *                                              持续音:fast 先回落,慢记忆拖长尾 → 两段式
 *   y      = x · 10^(-grDb/20) · makeup
 *
 * 与 src/audio/wdf/la2aWorklet.ts 内联实现逻辑一致——改动必须两边同步。
 */

export interface La2aOptoOptions {
  /** 采样率 */
  fs: number;
}

// T4B 时间常数(实测量级,见 docs 评测目标)
const ENV_REL_S = 0.005; // 峰值包络保持(整流后平滑;远快于 T4B,不主导动态)
const ATK_FAST_S = 0.01; // EL 面板发光 + LDR 快响应 ~10ms
const REL_FAST_S = 0.06; // 短瞬态后快释放 ~60ms(目标 50-70ms)
const ATK_SLOW_S = 0.25; // 光记忆充电(短 burst 几乎充不上)
const REL_SLOW_S = 1.3; // 光记忆消退(持续音后 ~1-2s 长尾)
/** 记忆分量稳态深度:决定持续音释放第一段(快)降到约一半后转入慢尾 */
const SLOW_DEPTH = 0.5;
/** 软拐点宽度(dB) */
const KNEE_DB = 15;
const RATIO_COMPRESS = 3;
const RATIO_LIMIT = 10;
/** 包络下限(-180dB),防 log(0) */
const ENV_FLOOR = 1e-9;
const LN10_OVER_20 = Math.log(10) / 20;

export class La2aOptoComp {
  private readonly coefEnvRel: number;
  private readonly coefAtkFast: number;
  private readonly coefRelFast: number;
  private readonly coefAtkSlow: number;
  private readonly coefRelSlow: number;

  /** 阈值(dBFS),由 REDUCTION 映射 */
  private thresholdDb = 2 - 0.42 * 30;
  private ratio = RATIO_COMPRESS;
  private makeup = 1;

  // 包络状态(每通道独立)
  private envLin = 0;
  private fastDb = 0;
  private slowDb = 0;

  /** 当前增益缩减量(dB,≥0),评测脚本直接读取 */
  grDb = 0;

  constructor(opts: La2aOptoOptions) {
    const fs = opts.fs;
    this.coefEnvRel = Math.exp(-1 / (ENV_REL_S * fs));
    this.coefAtkFast = 1 - Math.exp(-1 / (ATK_FAST_S * fs));
    this.coefRelFast = 1 - Math.exp(-1 / (REL_FAST_S * fs));
    this.coefAtkSlow = 1 - Math.exp(-1 / (ATK_SLOW_S * fs));
    this.coefRelSlow = 1 - Math.exp(-1 / (REL_SLOW_S * fs));
  }

  /** REDUCTION 0~100 → 阈值 +2 ~ -40dBFS(LA-2A 面板逻辑:拧大 = 压得多) */
  setReduction(r: number): void {
    const rc = Math.min(100, Math.max(0, r));
    this.thresholdDb = 2 - 0.42 * rc;
  }

  /** MODE:0 = Compress(3:1),≥0.5 = Limit(10:1) */
  setMode(mode: number): void {
    this.ratio = mode >= 0.5 ? RATIO_LIMIT : RATIO_COMPRESS;
  }

  /** GAIN 补偿增益(线性,dB 域由外层转换) */
  setMakeupGain(lin: number): void {
    this.makeup = Math.min(40, Math.max(0, lin));
  }

  /** 静态增益缩减(dB):宽软拐点,over 超过膝区后斜率 1-1/R */
  private staticGrDb(envDb: number): number {
    const over = envDb - this.thresholdDb;
    const slope = 1 - 1 / this.ratio;
    const halfK = KNEE_DB / 2;
    if (over <= -halfK) return 0;
    if (over >= halfK) return slope * over;
    const t = over + halfK;
    return (slope * t * t) / (2 * KNEE_DB);
  }

  process(x: number): number {
    // 峰值包络:瞬时攻击(峰值响应),5ms 指数释放
    const ax = Math.abs(x);
    this.envLin = ax > this.envLin ? ax : this.envLin * this.coefEnvRel;
    const envDb = Math.log(this.envLin + ENV_FLOOR) / LN10_OVER_20;
    const gr = this.staticGrDb(envDb);

    // 快分量(EL 面板 + LDR 快响应)
    const cF = gr > this.fastDb ? this.coefAtkFast : this.coefRelFast;
    this.fastDb += cF * (gr - this.fastDb);
    // 光记忆分量(半深度,慢充慢放)
    const sTarget = SLOW_DEPTH * gr;
    const cS = sTarget > this.slowDb ? this.coefAtkSlow : this.coefRelSlow;
    this.slowDb += cS * (sTarget - this.slowDb);

    this.grDb = Math.max(this.fastDb, this.slowDb);
    return x * Math.exp(-this.grDb * LN10_OVER_20) * this.makeup;
  }
}
