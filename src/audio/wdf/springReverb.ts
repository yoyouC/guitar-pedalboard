/**
 * 弹簧混响(Spring Reverb,Fender Twin 弹簧箱风格)DSP 核心 —— 纯 TS,Node 可测。
 *
 * 结构(每通道独立一条链):
 *   输入 → 预限带 LP(8kHz,驱动/拾取换能器带宽)→ 预弥散(2 级串联全通,涂抹瞬态)
 *   → 三条并联"弹簧"环(三弹簧箱,模态更密、包络更平)→ 求和 → 湿声
 *   每条弹簧环(反馈环):
 *     入口 28Hz 一阶 HP(防直流/低频堆积,换能器本来就是带限的)
 *     → 主延迟线(24/31ms,弹簧往返渡越)
 *     → 6 级 Schroeder 短延迟全通(2~6ms 不等,色散 → 金属 "boing" 啁啾)
 *     → 一阶阻尼低通(TONE,直流增益 1 → 每循环一圈高频多衰一点,余音随时间变暗)
 *     → 反馈增益 g(由 TIME 的 RT60 目标反推)→ 回到环入口
 *
 * 反馈增益:g = 10^(-3·T_eff/RT60) / |H_damp(fRef)|
 *   T_eff = 主延迟 + Σ 全通延迟(全通级联的谱平均群延迟恰等于其延迟之和,
 *   与实测衰减周期吻合);|H_damp(fRef)| 补偿阻尼低通在尾部主导频段的
 *   额外损耗(fRef 经实测校准)。
 * 三条弹簧环主延迟/全通延迟取不可通约值,避免单一重复周期(扑翼感);
 * 立体声第二通道整体延迟 ×1.021 去谐,获得去相关宽度。
 *
 * 全链路线性(无削波/饱和),按 docs/wdf-whitebox-process.md §1.3 不需要过采样。
 *
 * 与 src/audio/wdf/springreverbWorklet.ts 内联 JS 逻辑一致——改动必须两边同步。
 */

export interface SpringReverbOptions {
  /** 采样率(不重采样,直接用宿主 sampleRate) */
  fs: number;
  /** 声道去谐因子(立体声解相关),默认 1 */
  detune?: number;
}

// ---- 弹簧物理常数(通道 0 基准,ms)----
/** 弹簧 A:主往返延迟 + 6 级全通色散延迟 */
const MAIN_MS_A = 23.7;
const AP_MS_A = [5.9, 4.4, 3.7, 3.3, 2.5, 2.1];
/** 弹簧 B:与 A 不可通约,抑制单一重复周期 */
const MAIN_MS_B = 31.1;
const AP_MS_B = [5.6, 4.1, 3.4, 3.0, 2.7, 2.2];
/** 弹簧 C:第三条,与 A/B 均不可通约 */
const MAIN_MS_C = 27.3;
const AP_MS_C = [5.2, 4.6, 3.6, 2.9, 2.4, 2.0];
/** 输入预弥散(串联全通,把瞬态涂抹开,消除首反射离散感;换能器惯性的等效) */
const PREDIFF_MS = [4.7, 3.1];
const PREDIFF_GAIN = 0.55;

/** 环内高通(防 DC 堆积) */
const HP_FC = 28;
/** 输入预限带(换能器带宽) */
const PRE_LP_FC = 8000;
/** TONE 阻尼低通行程(Hz,对数映射) */
const TONE_FC_MIN = 1200;
const TONE_FC_MAX = 7000;
/** DWELL → 全通反馈系数行程(色散/啁啾强度) */
const DWELL_AP_MIN = 0.3;
const DWELL_AP_MAX = 0.72;
/** RT60 阻尼补偿参考频率(Hz,尾部能量主导频段,经 wdf-springreverb-eval 实测校准) */
const RT60_REF_HZ = 500;
/** 反馈增益安全上限 */
const G_MAX = 0.97;

/** 整数样本延迟线(环形缓冲) */
class DelayLine {
  private buf: Float32Array;
  private idx = 0;
  constructor(n: number) {
    this.buf = new Float32Array(Math.max(1, n));
  }
  process(x: number): number {
    const y = this.buf[this.idx];
    this.buf[this.idx] = x;
    this.idx = (this.idx + 1) % this.buf.length;
    return y;
  }
}

/**
 * Schroeder 短延迟全通:H(z) = (z^-m - a) / (1 - a·z^-m)
 * 单位幅频、直流增益 1;群延迟 τ(ω) = m(1-a²)/(1 - 2a·cos(ωm) + a²),
 * 随频率起伏 → 每循环一圈能量在时间上被"涂抹"(弥散),是 boing 金属感的来源。
 */
class Allpass {
  private buf: Float32Array;
  private idx = 0;
  /** 反馈系数(0~0.72,DWELL 控制) */
  a = 0.5;
  constructor(n: number) {
    this.buf = new Float32Array(Math.max(1, n));
  }
  process(x: number): number {
    const d = this.buf[this.idx];
    const y = d - this.a * x;
    this.buf[this.idx] = x + this.a * y;
    this.idx = (this.idx + 1) % this.buf.length;
    return y;
  }
}

/** 一阶低通(直流增益 1):H(z) = α / (1 - (1-α)z^-1) */
class OnePoleLP {
  private y = 0;
  alpha: number;
  constructor(fc: number, fs: number) {
    this.alpha = 1 - Math.exp((-2 * Math.PI * fc) / fs);
  }
  setFc(fc: number, fs: number): void {
    this.alpha = 1 - Math.exp((-2 * Math.PI * fc) / fs);
  }
  process(x: number): number {
    this.y += this.alpha * (x - this.y);
    return this.y;
  }
}

/** 一阶高通:y[n] = a·(y[n-1] + x[n] - x[n-1]) */
class OnePoleHP {
  private xm1 = 0;
  private ym1 = 0;
  private a: number;
  constructor(fc: number, fs: number) {
    this.a = 1 / (1 + (2 * Math.PI * fc) / fs);
  }
  process(x: number): number {
    const y = this.a * (this.ym1 + x - this.xm1);
    this.xm1 = x;
    this.ym1 = y;
    return y;
  }
}

/** 一阶低通在频率 f 处的幅频响应(用于 RT60 阻尼补偿) */
function onePoleLpMag(alpha: number, f: number, fs: number): number {
  const w = (2 * Math.PI * f) / fs;
  const c = Math.cos(w);
  const b = 1 - alpha;
  return alpha / Math.sqrt(1 + b * b - 2 * b * c);
}

/** 一条"弹簧"反馈环 */
class SpringLoop {
  private hp: OnePoleHP;
  private main: DelayLine;
  private aps: Allpass[];
  private damp: OnePoleLP;
  private fb = 0;
  /** 反馈增益(recompute 计算) */
  g = 0.9;
  /** 主延迟(秒) */
  private mainSec: number;
  /** 全通级延迟(秒) */
  private apSecs: number[];

  constructor(fs: number, mainMs: number, apMs: number[], detune: number) {
    this.hp = new OnePoleHP(HP_FC, fs);
    this.mainSec = (mainMs * detune) / 1000;
    this.main = new DelayLine(Math.round((mainMs * detune * fs) / 1000));
    this.apSecs = apMs.map((m) => (m * detune) / 1000);
    this.aps = apMs.map((m) => new Allpass(Math.round((m * detune * fs) / 1000)));
    this.damp = new OnePoleLP(2900, fs);
  }

  /** 有效环长(秒):主延迟 + 各级全通延迟(全通级联的谱平均群延迟 = 延迟之和) */
  effLoopSeconds(): number {
    let t = this.mainSec;
    for (const m of this.apSecs) t += m;
    return t;
  }

  setApGain(a: number): void {
    for (const ap of this.aps) ap.a = a;
  }

  setDampAlpha(alpha: number): void {
    this.damp.alpha = alpha;
  }

  process(x: number): number {
    let v = this.hp.process(x + this.fb);
    v = this.main.process(v);
    for (const ap of this.aps) v = ap.process(v);
    v = this.damp.process(v);
    this.fb = v * this.g;
    return v;
  }
}

/**
 * 弹簧混响罐(单声道实例;立体声由外层每通道各建一条)。
 * 参数:snap 式设置(平滑由 worklet 侧 setTargetAtTime 完成,评测侧阶跃设置即可)。
 */
export class SpringReverb {
  private fs: number;
  private preLp: OnePoleLP;
  private preDiff: Allpass[];
  private loopA: SpringLoop;
  private loopB: SpringLoop;
  private loopC: SpringLoop;

  private time = 2.0; // RT60 目标(s)
  private dwell = 50; // 0~100
  private tone = 50; // 0~100

  constructor(opts: SpringReverbOptions) {
    this.fs = opts.fs;
    const det = opts.detune ?? 1;
    this.preLp = new OnePoleLP(PRE_LP_FC, this.fs);
    this.preDiff = PREDIFF_MS.map((m) => {
      const ap = new Allpass(Math.round((m * det * this.fs) / 1000));
      ap.a = PREDIFF_GAIN;
      return ap;
    });
    this.loopA = new SpringLoop(this.fs, MAIN_MS_A, AP_MS_A, det);
    this.loopB = new SpringLoop(this.fs, MAIN_MS_B, AP_MS_B, det);
    this.loopC = new SpringLoop(this.fs, MAIN_MS_C, AP_MS_C, det);
    this.recompute();
  }

  /** TIME:RT60 目标,1~4 s */
  setTime(t: number): void {
    this.time = Math.min(4, Math.max(1, t));
    this.recompute();
  }

  /** DWELL:0~100 → 全通色散强度(弥散密度/啁啾感) */
  setDwell(d: number): void {
    this.dwell = Math.min(100, Math.max(0, d));
    this.recompute();
  }

  /** TONE:0~100 → 阻尼低通 1.2k~7k Hz(对数) */
  setTone(t: number): void {
    this.tone = Math.min(100, Math.max(0, t));
    this.recompute();
  }

  private recompute(): void {
    const a = DWELL_AP_MIN + (DWELL_AP_MAX - DWELL_AP_MIN) * (this.dwell / 100);
    const fc = TONE_FC_MIN * Math.pow(TONE_FC_MAX / TONE_FC_MIN, this.tone / 100);
    const alpha = 1 - Math.exp((-2 * Math.PI * fc) / this.fs);
    for (const loop of [this.loopA, this.loopB, this.loopC]) {
      loop.setApGain(a);
      loop.setDampAlpha(alpha);
      const tEff = loop.effLoopSeconds();
      const comp = onePoleLpMag(alpha, RT60_REF_HZ, this.fs);
      loop.g = Math.min(G_MAX, Math.pow(10, (-3 * tEff) / this.time) / comp);
    }
  }

  /** 处理一个样本,返回湿声(干湿混合由外层完成) */
  process(x: number): number {
    let v = this.preLp.process(x);
    for (const ap of this.preDiff) v = ap.process(v);
    return (this.loopA.process(v) + this.loopB.process(v) + this.loopC.process(v)) / 3;
  }
}
