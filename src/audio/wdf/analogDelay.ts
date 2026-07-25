/**
 * BBD 模拟延迟核心(Boss DM-2 / Memory Man 风格),纯 TS 实现,可 Node 直测。
 *
 * 结构(每通道独立实例):
 *   输入 → 固定输入 LP(2.5kHz 一阶,抗混叠/首遍损耗)→ 延迟线(线性插值分数延迟)
 *   延迟线输出 → 双一阶 LP(TONE 控制截止 700Hz~7kHz)→ ×FEEDBACK → 回灌写入端
 *     → 每次重复多过一次双极点 LP,逐级变暗(1.5~3kHz 渐低)
 *   LFO(0.9Hz 正弦,MOD 深度 0~±2.5ms)调制读指针 → 仅重复音 vibrato,干声不动
 *   BBD/压缩扩展器本底噪声:写入端注入小幅均匀噪声(经输入 LP 限带)
 *   输出 = 干声(恒 1)+ MIX × 湿声
 *
 * 线性系统(无削波),不需要过采样,直接跑 sampleRate。
 * TIME 变化经 ~25ms 摆率平滑(BBD 时钟只能渐变,顺带防爆音与变调滑音)。
 *
 * worklet(src/audio/wdf/analogdelayWorklet.ts)内联同一份 JS 逻辑——
 * 改动请两边同步(worklet 无法 import,故内联)。
 */

export interface BbdDelayOptions {
  /** 采样率 Hz(直接用宿主宰,无过采样) */
  fs: number;
  /** 延迟线容量上限 ms,默认 650(覆盖 600ms + 调制摆幅 + 插值余量) */
  maxDelayMs?: number;
}

/** BBD 本底噪声幅度(≈ -70dBFS 峰值) */
const NOISE_AMP = 3e-4;
/** 输入抗混叠/首遍 LP 截止 */
const LP_IN_HZ = 2500;
/** TONE 反馈 LP 截止行程(对数) */
const TONE_FC_MIN = 700;
const TONE_FC_MAX = 7000;
/** 调制 LFO 固定速率与最大深度 */
const MOD_RATE_HZ = 0.9;
const MOD_MAX_MS = 2.5;
/** TIME 摆率平滑时间常数 */
const TIME_SLEW_MS = 25;

const TWO_PI = 2 * Math.PI;

export class BbdAnalogDelay {
  private readonly fs: number;
  private readonly buf: Float32Array;
  private write = 0;

  // TIME(样本,带摆率)
  private dTarget: number;
  private dCur: number;
  private readonly timeSlew: number;

  // 参数
  private fb = 0.4;
  private mix = 0.35;
  private modDepth = 0; // 样本

  // LFO
  private lfoPhase = 0;
  private readonly lfoInc: number;

  // 滤波器系数与状态
  private readonly aIn: number;
  private aTone: number;
  private lpInY = 0;
  private lpFb1Y = 0;
  private lpFb2Y = 0;

  constructor(opts: BbdDelayOptions) {
    this.fs = opts.fs;
    const maxMs = opts.maxDelayMs ?? 650;
    this.buf = new Float32Array(Math.ceil((this.fs * (maxMs + 20)) / 1000));
    this.timeSlew = 1 - Math.exp(-1 / ((this.fs * TIME_SLEW_MS) / 1000));
    this.lfoInc = (TWO_PI * MOD_RATE_HZ) / this.fs;
    this.aIn = 1 / (this.fs / (TWO_PI * LP_IN_HZ) + 1);
    this.aTone = this.toneCoef(55);
    // 默认 300ms,建立即到位(评测从构造即稳态)
    this.dTarget = (300 * this.fs) / 1000;
    this.dCur = this.dTarget;
  }

  private toneCoef(pct: number): number {
    const p = Math.min(100, Math.max(0, pct)) / 100;
    const fc = TONE_FC_MIN * Math.pow(TONE_FC_MAX / TONE_FC_MIN, p);
    return 1 / (this.fs / (TWO_PI * fc) + 1);
  }

  /** TIME:延迟时间 ms(20~600,内部钳到容量内) */
  setTime(ms: number): void {
    const maxMs = ((this.buf.length - 4) / this.fs) * 1000 - MOD_MAX_MS;
    this.dTarget = (Math.min(maxMs, Math.max(1, ms)) * this.fs) / 1000;
  }

  /** FEEDBACK:反馈量 %(0~95,环路含 LP,增益恒 <1 稳定) */
  setFeedback(pct: number): void {
    this.fb = Math.min(0.95, Math.max(0, pct / 100));
  }

  /** TONE:重复暗度 %(0 最暗 700Hz ~ 100 最亮 7kHz,对数行程) */
  setTone(pct: number): void {
    this.aTone = this.toneCoef(pct);
  }

  /** MOD:调制深度 %(0~100 → 0~±2.5ms,0.9Hz 正弦) */
  setMod(pct: number): void {
    this.modDepth = (Math.min(100, Math.max(0, pct)) / 100) * ((MOD_MAX_MS * this.fs) / 1000);
  }

  /** MIX:湿声比例 %(0~100 → 0~1,干声恒 1) */
  setMix(pct: number): void {
    this.mix = Math.min(1, Math.max(0, pct / 100));
  }

  process(x: number): number {
    // TIME 摆率平滑(BBD 时钟渐变 → 变时间时的经典变调滑音)
    this.dCur += (this.dTarget - this.dCur) * this.timeSlew;

    // LFO:只摆读指针 → 重复音 vibrato
    const mod = this.modDepth * Math.sin(this.lfoPhase);
    this.lfoPhase += this.lfoInc;
    if (this.lfoPhase >= TWO_PI) this.lfoPhase -= TWO_PI;

    // 输入 LP + 本底噪声(噪声经 LP 限带,BBD 听感)
    const noisy = x + (Math.random() * 2 - 1) * NOISE_AMP;
    this.lpInY += this.aIn * (noisy - this.lpInY);

    // 分数延迟读(线性插值)
    const len = this.buf.length;
    const rp = this.write - (this.dCur + mod);
    const r0 = Math.floor(rp);
    const frac = rp - r0;
    const i0 = ((r0 % len) + len) % len;
    const i1 = (i0 + 1) % len;
    const dly = this.buf[i0] * (1 - frac) + this.buf[i1] * frac;

    // 反馈路径:双一阶 LP(每循环一次多过两个极点,逐级变暗)+ 反馈增益
    this.lpFb1Y += this.aTone * (dly - this.lpFb1Y);
    this.lpFb2Y += this.aTone * (this.lpFb1Y - this.lpFb2Y);
    this.buf[this.write] = this.lpInY + this.fb * this.lpFb2Y;
    this.write = (this.write + 1) % len;

    return x + this.mix * dly;
  }
}
