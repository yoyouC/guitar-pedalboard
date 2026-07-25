/**
 * FET 压缩(1176 风格)DSP 核心 —— 纯 TS、无 AudioContext 依赖,Node 可直接测试。
 *
 * 信号链(每通道一个独立实例):
 *   输入 → 峰值检测(|x|,瞬时)→ 电平 dB → 增益计算机(硬拐点,前馈)
 *        → GR 包络(dB 域单极点:ATTACK 20~800µs / RELEASE 50~1100ms,1176 规格)
 *        → 线性增益级 → FET 输出级饱和(4x 过采样 + tanh 软饱和/平方律偶次项)→ LEVEL
 *
 * 增益计算机(前馈):over = levelDb - thr;over > 0 时 GR = over·(1 - 1/R),
 * ALL 档 R = ∞(压限)。前馈结构保证静态压缩曲线与面板比率精确吻合(L1 评测 ±1dB)。
 *
 * 饱和级:y = tanh(k·(u + β·u²))/k。小信号增益 = 1(近透明);FET 平方律 → H2,
 * tanh 三次方 → H3;ALL 档加大 k/β(all-buttons-in 的重饱和)。饱和非线性在 4x
 * 过采样域进行(复用 resample.ts 多相升采样 + 48 阶 FIR 抗混叠降采样)。
 * 饱和驱动随 GR 加深(drive = 1 + 0.4·grDb):FET 压敏电阻深压进三极管区 +
 * 输出级补偿增益更吃力 —— 高比率/深压缩下失真明显增加,阈下保持近透明。
 *
 * worklet(src/audio/wdf/fet1176Worklet.ts)内联同一份 JS 逻辑 —— 改动必须两边同步。
 */
import { Decimator4x, OS_FACTOR, Upsampler4x, makeAntiAliasFIR } from './resample.ts';

/** RATIO 档位:索引 0..3 = 4/8/12/20:1,4 = ALL BUTTONS IN(压限 + 重饱和) */
export const FET1176_RATIO_STEPS: readonly number[] = [4, 8, 12, 20, Number.POSITIVE_INFINITY];

export const FET1176_ATTACK_US_MIN = 20;
export const FET1176_ATTACK_US_MAX = 800;
export const FET1176_RELEASE_MS_MIN = 50;
export const FET1176_RELEASE_MS_MAX = 1100;

const LN10_OVER_20 = Math.log(10) / 20;
/** 检测电平底(-140dB),防 log10(0) */
const DB_FLOOR = 1e-7;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export class FetCompressor {
  private readonly fs: number;
  private thresholdDb = -20;
  private slope = 1 - 1 / 8; // 增益计算机斜率 1-1/R;ALL 档 = 1
  private attackCoef = 0;
  private releaseCoef = 0;
  private levelGain = 1;
  private satK = 0.5;    // 饱和驱动(ALL 档加大)
  private satBeta = 0.06; // 平方律(偶次谐波)分量(ALL 档加大)
  private gr = 0;         // 当前增益衰减,dB(≥0)

  private readonly up: Upsampler4x;
  private readonly down: Decimator4x;
  private readonly osBuf: Float32Array;

  constructor(opts: { fs: number }) {
    this.fs = opts.fs;
    const fir = makeAntiAliasFIR();
    this.up = new Upsampler4x(fir);
    this.down = new Decimator4x(fir);
    this.osBuf = new Float32Array(OS_FACTOR);
    this.setRatioIndex(1);
    this.setAttackUs(200);
    this.setReleaseMs(250);
  }

  /** 当前增益衰减(dB,表桥/评测用) */
  get grDb(): number {
    return this.gr;
  }

  setThresholdDb(v: number): void {
    this.thresholdDb = clamp(v, -60, 0);
  }

  /** RATIO 档 0..4 → 4/8/12/20:1/ALL */
  setRatioIndex(i: number): void {
    const idx = clamp(Math.round(i), 0, FET1176_RATIO_STEPS.length - 1);
    const R = FET1176_RATIO_STEPS[idx];
    if (R === Number.POSITIVE_INFINITY) {
      this.slope = 1;   // 压限
      this.satK = 1.2;  // 重饱和
      this.satBeta = 0.25;
    } else {
      this.slope = 1 - 1 / R;
      this.satK = 0.5;
      this.satBeta = 0.06;
    }
  }

  setAttackUs(us: number): void {
    const tau = clamp(us, FET1176_ATTACK_US_MIN, FET1176_ATTACK_US_MAX) * 1e-6;
    this.attackCoef = 1 - Math.exp(-1 / (this.fs * tau));
  }

  setReleaseMs(ms: number): void {
    const tau = clamp(ms, FET1176_RELEASE_MS_MIN, FET1176_RELEASE_MS_MAX) * 1e-3;
    this.releaseCoef = 1 - Math.exp(-1 / (this.fs * tau));
  }

  /** LEVEL:线性增益(dB 域由外层 levelDbToGain 转换后传入) */
  setLevelGain(g: number): void {
    this.levelGain = clamp(g, 0, 4);
  }

  /** FET 输出级饱和:平方律偶次项 + tanh 软饱和,小信号增益 1 */
  private sat(u: number): number {
    return Math.tanh(this.satK * (u + this.satBeta * u * u)) / this.satK;
  }

  process(x: number): number {
    // 1) 峰值检测 + dB 域增益计算机
    const a = Math.abs(x);
    const levelDb = 20 * Math.log10(a < DB_FLOOR ? DB_FLOOR : a);
    const over = levelDb - this.thresholdDb;
    const target = over > 0 ? over * this.slope : 0;
    // 2) ATTACK/RELEASE 包络(dB 域单极点:GR 增大走 attack,减小走 release)
    const coef = target > this.gr ? this.attackCoef : this.releaseCoef;
    this.gr += coef * (target - this.gr);
    // 3) 增益级
    const y = x * Math.exp(-this.gr * LN10_OVER_20);
    // 4) 4x 过采样 FET 输出级饱和(抗混叠 FIR 降采样);驱动随 GR 加深
    const drive = 1 + 0.4 * this.gr;
    this.up.process(this.osBuf, y);
    const s0 = this.sat(drive * this.osBuf[0]) / drive;
    const s1 = this.sat(drive * this.osBuf[1]) / drive;
    const s2 = this.sat(drive * this.osBuf[2]) / drive;
    const s3 = this.sat(drive * this.osBuf[3]) / drive;
    return this.down.process(s0, s1, s2, s3) * this.levelGain;
  }
}
