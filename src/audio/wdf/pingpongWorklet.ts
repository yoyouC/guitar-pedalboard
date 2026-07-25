/**
 * 乒乓延迟(Ping-Pong Delay)的 AudioWorklet 处理器(Blob 内联,免构建配置)。
 *
 * 链路:输入 L/R 求和为 mono 注入 L 侧延迟线 → 交叉耦合双延迟线(回声 L/R 交替)
 *   → 反馈路径一阶低通(3.5kHz)+ FEEDBACK → 干路(恒 1)与湿路(MIX)混合输出。
 *   全线性,工作在 sampleRate,无需过采样。IIFE 隔离全局名;立体声对共用一条
 *   交叉耦合链(乒乓本身即声道间耦合,非独立双 mono)。
 *
 * DSP 逻辑与 src/audio/wdf/pingPongDelay.ts 一致——改动请两边同步。
 */
const processorSource = `(() => {
const LP_FC = 3500;

class PingPongDelayCore {
  constructor(fs, maxDelayMs) {
    this.fs = fs;
    this.maxDelayMs = maxDelayMs;
    const n = Math.ceil((fs * maxDelayMs) / 1000) + 2;
    this.bufL = new Float32Array(n);
    this.bufR = new Float32Array(n);
    this.idx = 0;
    this.delaySamples = 1;
    this.feedback = 0.4;
    this.mix = 0.3;
    const T = 1 / fs;
    this.lpA = T / (1 / (2 * Math.PI * LP_FC) + T);
    this.lpL = 0;
    this.lpR = 0;
    this.outL = 0;
    this.outR = 0;
    this.setTimeMs(400);
  }
  setTimeMs(ms) {
    const clamped = Math.min(this.maxDelayMs, Math.max(0.1, ms));
    const d = Math.round((clamped / 1000) * this.fs);
    this.delaySamples = Math.min(this.bufL.length - 1, Math.max(1, d));
  }
  setFeedback(fb) {
    this.feedback = Math.min(0.98, Math.max(0, fb));
  }
  setMix(mix) {
    this.mix = Math.min(1, Math.max(0, mix));
  }
  process(inL, inR) {
    const n = this.bufL.length;
    const rd = (this.idx - this.delaySamples + n) % n;
    const dL = this.bufL[rd];
    const dR = this.bufR[rd];
    const mono = 0.5 * (inL + inR);
    this.lpL += this.lpA * (dL - this.lpL);
    this.lpR += this.lpA * (dR - this.lpR);
    this.bufL[this.idx] = mono + this.feedback * this.lpR;
    this.bufR[this.idx] = this.feedback * this.lpL;
    this.idx = (this.idx + 1) % n;
    this.outL = inL + this.mix * dL;
    this.outR = inR + this.mix * dR;
  }
}

class PingPongDelayProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'time', defaultValue: 400, minValue: 50, maxValue: 1500 },
      { name: 'feedback', defaultValue: 40, minValue: 0, maxValue: 90 },
      { name: 'mix', defaultValue: 30, minValue: 0, maxValue: 100 },
    ];
  }

  constructor() {
    super();
    this.core = new PingPongDelayCore(sampleRate, 1500);
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

registerProcessor('pingpong-delay', PingPongDelayProcessor);
})();`;

let loaded = false;

/** 幂等加载,使用前必须先 await */
export async function loadPingPongDelay(ctx: AudioContext): Promise<void> {
  if (loaded) return;
  const url = URL.createObjectURL(
    new Blob([processorSource], { type: 'application/javascript' }),
  );
  try {
    await ctx.audioWorklet.addModule(url);
    loaded = true;
  } finally {
    URL.revokeObjectURL(url);
  }
}
