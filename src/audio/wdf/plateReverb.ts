/**
 * 板式混响(Plate Reverb,EMT-140 风格)DSP 核心 —— 纯 TS,无 AudioContext 依赖,Node 可测。
 *
 * 拓扑(Dattorro plate 的 FDN 变体):
 *   输入 → PREDELAY(0~100ms;分数延迟线性插值,读位置一阶平滑 → 调参无爆音)
 *        → 4 级串联输入扩散全通(k=0.6,建立高初始反射密度)
 *        → 反馈环:AP1 → AP2 → 延迟线 D1 → 阻尼一阶低通(DAMP)→ 衰减 g
 *                → AP3 → AP4 → 延迟线 D2 → 衰减 g →(回注环入口)
 *   湿声 = D1/D2 上共 12 个抽头(非均匀间距 + 交替符号去相关)加权和;
 *   输出 = cos(m·π/2)·干 + sin(m·π/2)·湿(等功率交叉,MIX=100% 可全湿)。
 *
 * 衰减设计:
 * - 全通 |H(e^jω)| ≡ 1(无损),环路增益全部落在两个衰减增益上:
 *   每圈增益 G = 10^(-3·T_loop/RT60),g = √G → RT60 由 TIME 解析给定。
 *   环内全通特意取短(总状态 ~14% 环长):全通在反馈环内会储能,
 *   既使实测 RT60 偏长(大 k/长延迟时偏差可达 43%),其单程振铃还构成
 *   短 TIME 下不可越过的 RT60 地板;短全通 + k=0.6 后,0.5~6s 全行程
 *   实测 RT60 与名义公式偏差 ≤9%(scripts/wdf-plate-eval.ts 全行程验证)。
 * - 阻尼低通在环内,|H(0)| = 1、高频 < 1 → 高频每圈额外衰减:
 *   RT60(f) 随频率升高而缩短(板式物理特性),DAMP 控制程度,中低频不受影响。
 * - 线性系统,无需过采样,直接用 sampleRate。
 *
 * variant 0/1 为两组互质延迟长度;worklet 左右声道各用一组 → 立体声天然去相关。
 * worklet(src/audio/wdf/plateWorklet.ts)内联同一份逻辑 —— 改动必须两边同步。
 */

/** 输入扩散级全通增益(比 Dattorro 0.75 小:收敛单程扩散振铃的 RT60 地板) */
const K_INPUT = 0.6;
/** 环内扩散全通增益 */
const K_LOOP = 0.6;
/** PREDELAY 上限(ms) */
const MAX_PREDELAY_MS = 100;
/** DAMP=100% 时的环内一阶低通系数 */
const DAMP_COEF_MAX = 0.65;
/** 湿声 12 抽头归一化 */
const WET_NORM = 0.25;
/** 长度表基准采样率 */
const BASE_FS = 48000;

/** 输入扩散链长度(48kHz 基准;Dattorro plate 的 142/107/379/277 @29761Hz 换算后 ×0.7) */
const INPUT_AP_LEN = [160, 121, 428, 313];
/** 环内长度表:每 variant 4 个短全通 + 2 条延迟线(48kHz 基准,互质) */
const LOOP_LEN = [
  { ap: [293, 461, 631, 797], d: [7183, 6001] },
  { ap: [389, 557, 701, 863], d: [6803, 5101] },
];
/** 湿声抽头位置(所在延迟线长度的比例;非均匀间距,避免规则间隔形成周期回声) */
const TAPS1 = [0.06, 0.19, 0.37, 0.52, 0.74, 0.91];
const TAPS2 = [0.11, 0.26, 0.43, 0.59, 0.79, 0.93];

/** Schroeder 全通:y[n] = x[n-D] - k·x[n] + k·y[n-D];|k|<1 时 |H(e^jω)|≡1 */
class Allpass {
  readonly len: number;
  private readonly k: number;
  private readonly buf: Float32Array;
  private pos = 0;
  constructor(len: number, k: number) {
    this.len = len;
    this.k = k;
    this.buf = new Float32Array(len);
  }
  process(x: number): number {
    const b = this.buf[this.pos];
    const y = b - this.k * x;
    this.buf[this.pos] = x + this.k * y;
    this.pos = this.pos + 1 === this.len ? 0 : this.pos + 1;
    return y;
  }
}

/** 带抽头延迟线(环形缓冲,head 单调递增避免回绕歧义) */
class TapDelay {
  readonly len: number;
  private readonly buf: Float32Array;
  private head = 0;
  constructor(len: number) {
    this.len = len;
    this.buf = new Float32Array(len);
  }
  /** 写入 x[n],返回 x[n-len] */
  process(x: number): number {
    const i = this.head % this.len;
    const y = this.buf[i];
    this.buf[i] = x;
    this.head++;
    return y;
  }
  /** 读 x[n-m+1](1 ≤ m ≤ len-1);须在本样本 process() 之后调用 */
  tap(m: number): number {
    let i = (this.head - m) % this.len;
    if (i < 0) i += this.len;
    return this.buf[i];
  }
}

/** 预延迟:浮点读位置 + 线性插值 + 位置一阶平滑(τ≈10ms,调参防爆音) */
class PreDelay {
  private readonly buf: Float32Array;
  private readonly kPos: number;
  private readonly fs: number;
  private head = 0;
  private pos = 0;
  private target = 0;
  constructor(fs: number, maxMs: number) {
    this.fs = fs;
    this.buf = new Float32Array(Math.ceil((fs * maxMs) / 1000) + 2);
    this.kPos = 1 - Math.exp(-1 / (0.01 * fs));
  }
  setMs(ms: number): void {
    const c = Math.min(MAX_PREDELAY_MS, Math.max(0, ms));
    this.target = Math.min((c * this.fs) / 1000, this.buf.length - 2);
  }
  process(x: number): number {
    const len = this.buf.length;
    this.buf[this.head % len] = x;
    this.head++;
    this.pos += this.kPos * (this.target - this.pos);
    const m = this.pos > len - 2 ? len - 2 : this.pos;
    const m0 = Math.floor(m);
    const f = m - m0;
    let ia = (this.head - 1 - m0) % len;
    if (ia < 0) ia += len;
    let ib = ia - 1;
    if (ib < 0) ib += len;
    const a = this.buf[ia];
    return a + f * (this.buf[ib] - a);
  }
}

export interface PlateReverbOptions {
  /** 采样率(线性系统,直接用过采样前的 sampleRate) */
  fs: number;
  /** 延迟长度组:0/1 两组互质,立体声两链各用一组去相关 */
  variant?: 0 | 1;
}

export class PlateReverb {
  private readonly fs: number;
  private readonly pre: PreDelay;
  private readonly apIn: Allpass[];
  private readonly ap1: Allpass;
  private readonly ap2: Allpass;
  private readonly ap3: Allpass;
  private readonly ap4: Allpass;
  private readonly d1: TapDelay;
  private readonly d2: TapDelay;
  private readonly taps1: number[];
  private readonly taps2: number[];
  /** 环路总延迟(样本):4 个环内全通 + 2 条延迟线 */
  private readonly loopSamples: number;

  private dampS = 0;
  private fb = 0;
  private g = 0;
  private dampCoef = 0;
  private dry = Math.SQRT1_2;
  private wet = Math.SQRT1_2;
  private timeS = 0;
  private damp01 = -1;
  private mix01 = -1;

  constructor(opts: PlateReverbOptions) {
    const fs = opts.fs;
    this.fs = fs;
    const s = fs / BASE_FS;
    const len = (base: number): number => Math.max(4, Math.round(base * s));
    this.pre = new PreDelay(fs, MAX_PREDELAY_MS);
    this.apIn = INPUT_AP_LEN.map((L) => new Allpass(len(L), K_INPUT));
    const table = LOOP_LEN[opts.variant ?? 0];
    this.ap1 = new Allpass(len(table.ap[0]), K_LOOP);
    this.ap2 = new Allpass(len(table.ap[1]), K_LOOP);
    this.ap3 = new Allpass(len(table.ap[2]), K_LOOP);
    this.ap4 = new Allpass(len(table.ap[3]), K_LOOP);
    this.d1 = new TapDelay(len(table.d[0]));
    this.d2 = new TapDelay(len(table.d[1]));
    const offs = (fracs: number[], L: number): number[] =>
      fracs.map((f) => Math.min(L - 1, Math.max(1, Math.round(f * L))));
    this.taps1 = offs(TAPS1, this.d1.len);
    this.taps2 = offs(TAPS2, this.d2.len);
    this.loopSamples =
      this.ap1.len + this.ap2.len + this.ap3.len + this.ap4.len + this.d1.len + this.d2.len;

    this.setTime(2.5);
    this.setDamp(0.4);
    this.setPreDelayMs(0);
    this.setMix(0.3);
  }

  /** TIME:RT60 目标(秒),0.5~6 */
  setTime(t: number): void {
    const tc = Math.min(6, Math.max(0.5, t));
    if (tc === this.timeS) return;
    this.timeS = tc;
    const tLoop = this.loopSamples / this.fs;
    // 每圈幅度增益 G 满足 G^(RT60/T_loop) = 1e-3(-60dB)
    const gTrip = Math.pow(10, (-3 * tLoop) / tc);
    this.g = Math.sqrt(gTrip); // 两条延迟线后各 √G
  }

  /** DAMP 0~1 → 环内一阶低通系数(0 = 无阻尼,全频段 RT60 一致) */
  setDamp(d: number): void {
    const dc = Math.min(1, Math.max(0, d));
    if (dc === this.damp01) return;
    this.damp01 = dc;
    this.dampCoef = DAMP_COEF_MAX * dc;
  }

  /** PREDELAY 0~100ms */
  setPreDelayMs(ms: number): void {
    this.pre.setMs(ms);
  }

  /** MIX 0~1:等功率交叉,0 = 全干,1 = 全湿 */
  setMix(m: number): void {
    const mc = Math.min(1, Math.max(0, m));
    if (mc === this.mix01) return;
    this.mix01 = mc;
    this.dry = Math.cos((mc * Math.PI) / 2);
    this.wet = Math.sin((mc * Math.PI) / 2);
  }

  process(x: number): number {
    let s = this.pre.process(x);
    for (let i = 0; i < this.apIn.length; i++) s = this.apIn[i].process(s);
    const u = s + this.fb;
    const a = this.ap2.process(this.ap1.process(u));
    const d1o = this.d1.process(a);
    // 环内阻尼一阶低通:y = (1-d)·x + d·y[-1],|H(0)|=1
    this.dampS = (1 - this.dampCoef) * d1o + this.dampCoef * this.dampS;
    const b = this.ap4.process(this.ap3.process(this.g * this.dampS));
    const d2o = this.d2.process(b);
    this.fb = this.g * d2o;
    let w = 0;
    for (let i = 0; i < this.taps1.length; i++)
      w += (i % 2 === 0 ? 1 : -1) * this.d1.tap(this.taps1[i]);
    for (let i = 0; i < this.taps2.length; i++)
      w += (i % 2 === 0 ? -1 : 1) * this.d2.tap(this.taps2[i]);
    return this.dry * x + this.wet * (WET_NORM * w);
  }
}
