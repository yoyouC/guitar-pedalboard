/**
 * 乒乓延迟(Ping-Pong Delay)立体声 DSP 核心(纯 TS,Node 可测,无 AudioContext 依赖)。
 *
 * 拓扑(交叉耦合双延迟线):
 *   输入 L/R 求和为 mono,只注入 L 侧延迟线;
 *   L 线输出 → 第 1/3/5… 次回声(左声道),经一阶低通 + FEEDBACK 交叉馈入 R 线;
 *   R 线输出 → 第 2/4/6… 次回声(右声道),经一阶低通 + FEEDBACK 交叉馈回 L 线。
 *   第 k 次回声位于 k·TIME,声道严格交替(奇次 L,偶次 R),幅度 ∝ fb^(k-1);
 *   每反弹一次多经过一次低通,重复逐渐变暗("轻度低通与反馈")。
 *
 * 全线性系统,直接工作在 sampleRate,无需过采样。
 * 每样本零分配:结果写入 outL/outR 字段。
 *
 * worklet(src/audio/wdf/pingpongWorklet.ts)内联同一份逻辑——改动必须两边同步。
 */

/** 反馈路径一阶低通截止频率(Hz),轻度染色 */
export const PINGPONG_LP_FC = 3500;

export interface PingPongDelayOptions {
  /** 采样率 */
  fs: number;
  /** 最大延迟(ms),决定缓冲长度,默认 1500 */
  maxDelayMs?: number;
}

export class PingPongDelay {
  private readonly fs: number;
  private readonly maxDelayMs: number;
  private readonly bufL: Float32Array;
  private readonly bufR: Float32Array;
  private idx = 0; // 环形写指针(两线同长共用)
  private delaySamples = 1;
  private feedback = 0.4;
  private mix = 0.3;
  private readonly lpA: number; // 反馈低通系数(一阶,T/(RC+T) 形式)
  private lpL = 0; // L→R 交叉支路低通状态
  private lpR = 0; // R→L 交叉支路低通状态

  /** 最近一次 process 的输出(避免每样本分配) */
  outL = 0;
  outR = 0;

  constructor(opts: PingPongDelayOptions) {
    this.fs = opts.fs;
    this.maxDelayMs = opts.maxDelayMs ?? 1500;
    const n = Math.ceil((opts.fs * this.maxDelayMs) / 1000) + 2;
    this.bufL = new Float32Array(n);
    this.bufR = new Float32Array(n);
    const T = 1 / opts.fs;
    this.lpA = T / (1 / (2 * Math.PI * PINGPONG_LP_FC) + T);
    this.setTimeMs(400);
  }

  /** TIME:延迟时间 ms(整数样本,改变即时生效) */
  setTimeMs(ms: number): void {
    const clamped = Math.min(this.maxDelayMs, Math.max(0.1, ms));
    const d = Math.round((clamped / 1000) * this.fs);
    this.delaySamples = Math.min(this.bufL.length - 1, Math.max(1, d));
  }

  /** FEEDBACK:0~1(UI 百分域除以 100),钳 <1 保证衰减稳定 */
  setFeedback(fb: number): void {
    this.feedback = Math.min(0.98, Math.max(0, fb));
  }

  /** MIX:0~1(UI 百分域除以 100),干路恒为 1,湿路 = mix */
  setMix(mix: number): void {
    this.mix = Math.min(1, Math.max(0, mix));
  }

  process(inL: number, inR: number): void {
    const n = this.bufL.length;
    const rd = (this.idx - this.delaySamples + n) % n;
    // 先读后写:读到的永远是 delaySamples 之前的值,回声声道严格隔离
    const dL = this.bufL[rd];
    const dR = this.bufR[rd];

    const mono = 0.5 * (inL + inR);
    // 对侧信号经低通 + 反馈交叉馈入
    this.lpL += this.lpA * (dL - this.lpL);
    this.lpR += this.lpA * (dR - this.lpR);
    this.bufL[this.idx] = mono + this.feedback * this.lpR;
    this.bufR[this.idx] = this.feedback * this.lpL;
    this.idx = (this.idx + 1) % n;

    // 干路恒为 1,湿路按 mix 混合
    this.outL = inL + this.mix * dL;
    this.outR = inR + this.mix * dR;
  }
}
