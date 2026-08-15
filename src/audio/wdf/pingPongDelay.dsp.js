/**
 * 乒乓延迟(Ping-Pong Delay)DSP 核——单一来源(ADR-0003)。
 *
 * 拓扑(交叉耦合双延迟线,单实例立体声核——乒乓本身即声道间耦合,
 * 非独立双 mono):
 *   输入 L/R 求和为 mono,只注入 L 侧延迟线;
 *   L 线输出 → 第 1/3/5… 次回声(左声道),经一阶低通 + FEEDBACK 交叉馈入 R 线;
 *   R 线输出 → 第 2/4/6… 次回声(右声道),经一阶低通 + FEEDBACK 交叉馈回 L 线。
 *   第 k 次回声位于 k·TIME,声道严格交替(奇次 L,偶次 R),幅度 ∝ fb^(k-1);
 *   每反弹一次多经过一次低通,重复逐渐变暗("轻度低通与反馈")。
 *   干路恒为 1,湿路按 MIX 混合。
 * 全线性系统,直接工作在 sampleRate,无需过采样。
 *
 * 双模式消费:worklet 经 `?raw` 取源码字符串拼装 Blob;eval/测试直接 import。
 * 只用单行 import 与内联 export(buildProcessorSource 依赖此约定剥离)。
 * 本文件以原 pingpongWorklet.ts 内联版为权威逐表达式平移(类名
 * PingPongDelayCore → PingPongDelay 沿用旧 TS core 命名,issue #7)。
 */

/** 反馈路径一阶低通截止频率(Hz),轻度染色 */
export const PINGPONG_LP_FC = 3500;

/**
 * 交叉耦合双延迟线立体声核。每样本零分配:结果写入 outL/outR 字段。
 * @param {number} fs 采样率
 * @param {number} [maxDelayMs] 最大延迟(ms),决定缓冲长度,默认 1500
 */
export class PingPongDelay {
  constructor(fs, maxDelayMs = 1500) {
    this.fs = fs;
    this.maxDelayMs = maxDelayMs;
    const n = Math.ceil((fs * maxDelayMs) / 1000) + 2;
    this.bufL = new Float32Array(n);
    this.bufR = new Float32Array(n);
    this.idx = 0; // 环形写指针(两线同长共用)
    this.delaySamples = 1;
    this.feedback = 0.4;
    this.mix = 0.3;
    const T = 1 / fs;
    // 反馈低通系数(一阶,T/(RC+T) 形式)
    this.lpA = T / (1 / (2 * Math.PI * PINGPONG_LP_FC) + T);
    this.lpL = 0; // L→R 交叉支路低通状态
    this.lpR = 0; // R→L 交叉支路低通状态
    /** 最近一次 process 的输出(避免每样本分配) */
    this.outL = 0;
    this.outR = 0;
    this.setTimeMs(400);
  }

  /** TIME:延迟时间 ms(整数样本,改变即时生效) */
  setTimeMs(ms) {
    const clamped = Math.min(this.maxDelayMs, Math.max(0.1, ms));
    const d = Math.round((clamped / 1000) * this.fs);
    this.delaySamples = Math.min(this.bufL.length - 1, Math.max(1, d));
  }

  /** FEEDBACK:0~1(UI 百分域除以 100),钳 <1 保证衰减稳定 */
  setFeedback(fb) {
    this.feedback = Math.min(0.98, Math.max(0, fb));
  }

  /** MIX:0~1(UI 百分域除以 100),干路恒为 1,湿路 = mix */
  setMix(mix) {
    this.mix = Math.min(1, Math.max(0, mix));
  }

  process(inL, inR) {
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

/**
 * 乒乓延迟全链路引擎。process(inputs, outputs, params) 语义与
 * AudioWorkletProcessor.process 一致;采样率由构造注入(替代 worklet 全局
 * sampleRate),引擎内不含任何 AudioWorklet API。
 * 单实例立体声核;单声道输入复制为双声道、单声道输出折叠(0.5·(L+R))
 * 的兜底均与原内联处理器一致。
 */
export class PingPongDelayEngine {
  /** @param {number} sampleRate 采样率 */
  constructor(sampleRate) {
    this.core = new PingPongDelay(sampleRate, 1500);
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length || !output || !output.length) return true;
    const core = this.core;
    core.setTimeMs(params.time[0]);
    core.setFeedback(params.feedback[0] / 100);
    core.setMix(params.mix[0] / 100);

    const inL = input[0];
    // 单声道输入复制为双声道(mono 求和后首回声仍只在 L 侧)
    const inR = input.length > 1 ? input[1] : input[0];
    const outL = output[0];
    const outR = output.length > 1 ? output[1] : null;
    if (outR) {
      for (let i = 0; i < inL.length; i++) {
        core.process(inL[i], inR[i]);
        outL[i] = core.outL;
        outR[i] = core.outR;
      }
    } else {
      // 输出被折叠成单声道的兜底(正常配置 outputChannelCount:[2] 不会走到)
      for (let i = 0; i < inL.length; i++) {
        core.process(inL[i], inR[i]);
        outL[i] = 0.5 * (core.outL + core.outR);
      }
    }
    return true;
  }
}
