/**
 * BBD 模拟延迟(Boss DM-2 / Memory Man 风格)的 AudioWorklet 处理器
 *(Blob 内联,免构建配置;IIFE 隔离全局名;每通道独立延迟线状态)。
 *
 * 链路:输入 → 2.5kHz 输入 LP(+本底噪声)→ 延迟线(线性插值,TIME 摆率平滑,
 * 0.9Hz LFO 调制读指针)→ 双一阶 TONE LP → ×FEEDBACK 回灌;输出 = 干 + MIX×湿。
 * 线性系统,无过采样,直接用 sampleRate。
 *
 * DSP 逻辑与 src/audio/wdf/analogDelay.ts 的 BbdAnalogDelay 一致——改动请两边同步。
 */
import { createWorkletLoader } from '../workletLoader';

const processorSource = `(() => {
const NOISE_AMP = 3e-4;
const LP_IN_HZ = 2500;
const TONE_FC_MIN = 700;
const TONE_FC_MAX = 7000;
const MOD_RATE_HZ = 0.9;
const MOD_MAX_MS = 2.5;
const TIME_SLEW_MS = 25;
const TWO_PI = 2 * Math.PI;

class BbdAnalogDelay {
  constructor(fs, maxDelayMs) {
    this.fs = fs;
    this.buf = new Float32Array(Math.ceil((fs * ((maxDelayMs || 650) + 20)) / 1000));
    this.write = 0;
    this.timeSlew = 1 - Math.exp(-1 / ((fs * TIME_SLEW_MS) / 1000));
    this.lfoInc = (TWO_PI * MOD_RATE_HZ) / fs;
    this.lfoPhase = 0;
    this.aIn = 1 / (fs / (TWO_PI * LP_IN_HZ) + 1);
    this.fb = 0.4;
    this.mix = 0.35;
    this.modDepth = 0;
    this.lpInY = 0;
    this.lpFb1Y = 0;
    this.lpFb2Y = 0;
    this.aTone = this.toneCoef(55);
    this.dTarget = (300 * fs) / 1000;
    this.dCur = this.dTarget;
  }
  toneCoef(pct) {
    const p = Math.min(100, Math.max(0, pct)) / 100;
    const fc = TONE_FC_MIN * Math.pow(TONE_FC_MAX / TONE_FC_MIN, p);
    return 1 / (this.fs / (TWO_PI * fc) + 1);
  }
  setTime(ms) {
    const maxMs = ((this.buf.length - 4) / this.fs) * 1000 - MOD_MAX_MS;
    this.dTarget = (Math.min(maxMs, Math.max(1, ms)) * this.fs) / 1000;
  }
  setFeedback(pct) {
    this.fb = Math.min(0.95, Math.max(0, pct / 100));
  }
  setTone(pct) {
    this.aTone = this.toneCoef(pct);
  }
  setMod(pct) {
    this.modDepth = (Math.min(100, Math.max(0, pct)) / 100) * ((MOD_MAX_MS * this.fs) / 1000);
  }
  setMix(pct) {
    this.mix = Math.min(1, Math.max(0, pct / 100));
  }
  process(x) {
    this.dCur += (this.dTarget - this.dCur) * this.timeSlew;
    const mod = this.modDepth * Math.sin(this.lfoPhase);
    this.lfoPhase += this.lfoInc;
    if (this.lfoPhase >= TWO_PI) this.lfoPhase -= TWO_PI;
    const noisy = x + (Math.random() * 2 - 1) * NOISE_AMP;
    this.lpInY += this.aIn * (noisy - this.lpInY);
    const len = this.buf.length;
    const rp = this.write - (this.dCur + mod);
    const r0 = Math.floor(rp);
    const frac = rp - r0;
    const i0 = ((r0 % len) + len) % len;
    const i1 = (i0 + 1) % len;
    const dly = this.buf[i0] * (1 - frac) + this.buf[i1] * frac;
    this.lpFb1Y += this.aTone * (dly - this.lpFb1Y);
    this.lpFb2Y += this.aTone * (this.lpFb1Y - this.lpFb2Y);
    this.buf[this.write] = this.lpInY + this.fb * this.lpFb2Y;
    this.write = (this.write + 1) % len;
    return x + this.mix * dly;
  }
}

class BbdAnalogDelayProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'time', defaultValue: 300, minValue: 20, maxValue: 600, automationRate: 'k-rate' },
      { name: 'feedback', defaultValue: 40, minValue: 0, maxValue: 95, automationRate: 'k-rate' },
      { name: 'tone', defaultValue: 55, minValue: 0, maxValue: 100, automationRate: 'k-rate' },
      { name: 'mod', defaultValue: 0, minValue: 0, maxValue: 100, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 35, minValue: 0, maxValue: 100, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.chains = [];
    this.last = { time: -1, feedback: -1, tone: -1, mod: -1, mix: -1 };
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    while (this.chains.length < input.length) this.chains.push(new BbdAnalogDelay(sampleRate));

    const p = {
      time: params.time[0],
      feedback: params.feedback[0],
      tone: params.tone[0],
      mod: params.mod[0],
      mix: params.mix[0],
    };
    for (let ch = 0; ch < input.length; ch++) {
      const c = this.chains[ch];
      if (p.time !== this.last.time) c.setTime(p.time);
      if (p.feedback !== this.last.feedback) c.setFeedback(p.feedback);
      if (p.tone !== this.last.tone) c.setTone(p.tone);
      if (p.mod !== this.last.mod) c.setMod(p.mod);
      if (p.mix !== this.last.mix) c.setMix(p.mix);
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) out[i] = c.process(inp[i]);
    }
    this.last = p;
    return true;
  }
}

registerProcessor('bbd-analog-delay', BbdAnalogDelayProcessor);
})();`;

/** 幂等加载(按 AudioContext 注册),使用前必须先 await */
export const loadAnalogDelayWdf = createWorkletLoader(processorSource);
