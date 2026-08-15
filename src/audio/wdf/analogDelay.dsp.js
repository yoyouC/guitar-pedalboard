/**
 * BBD 模拟延迟(Boss DM-2 / Memory Man 风格)DSP 核——单一来源(ADR-0003)。
 *
 * 链路(每通道一个 BbdAnalogDelay 实例):
 *   输入 → 固定输入 LP(2.5kHz 一阶,+ BBD 本底噪声注入)→ 延迟线
 *   (线性插值分数延迟,TIME ~25ms 摆率平滑,0.9Hz LFO 调制读指针
 *   → 仅重复音 vibrato)→ 双一阶 TONE LP(700Hz~7kHz 对数行程,
 *   每次重复多过一对极点,逐级变暗)→ ×FEEDBACK 回灌写入端;
 *   输出 = 干声(恒 1)+ MIX × 湿声。
 *   线性系统(无削波),不需要过采样,直接跑构造注入的采样率。
 *
 * 双模式消费:worklet(analogdelayWorklet.ts)经 `?raw` 取源码字符串拼装
 * Blob;eval/测试直接 import。只用单行 import 与内联 export
 * (buildProcessorSource 依赖此约定剥离模块语法)。
 * 本文件以原 worklet 内联版为权威逐表达式平移(issue #7,音色零变化);
 * 构造签名取内联版的位置参数 (fs, maxDelayMs)(旧 core 的 {fs,...}
 * options 已废弃)。
 */

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

/**
 * 单通道 BBD 延迟核心(每样本 process(x) → y)。
 * 逐表达式平移自原 worklet 内联版;采样率由构造注入。
 */
export class BbdAnalogDelay {
  /**
   * @param {number} fs 采样率 Hz(直接用宿主宰,无过采样)
   * @param {number} [maxDelayMs] 延迟线容量上限 ms,默认 650
   *   (覆盖 600ms + 调制摆幅 + 插值余量)
   */
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
    // 默认 300ms,建立即到位(评测从构造即稳态)
    this.dTarget = (300 * fs) / 1000;
    this.dCur = this.dTarget;
  }

  toneCoef(pct) {
    const p = Math.min(100, Math.max(0, pct)) / 100;
    const fc = TONE_FC_MIN * Math.pow(TONE_FC_MAX / TONE_FC_MIN, p);
    return 1 / (this.fs / (TWO_PI * fc) + 1);
  }

  /** TIME:延迟时间 ms(20~600,内部钳到容量内) */
  setTime(ms) {
    const maxMs = ((this.buf.length - 4) / this.fs) * 1000 - MOD_MAX_MS;
    this.dTarget = (Math.min(maxMs, Math.max(1, ms)) * this.fs) / 1000;
  }

  /** FEEDBACK:反馈量 %(0~95,环路含 LP,增益恒 <1 稳定) */
  setFeedback(pct) {
    this.fb = Math.min(0.95, Math.max(0, pct / 100));
  }

  /** TONE:重复暗度 %(0 最暗 700Hz ~ 100 最亮 7kHz,对数行程) */
  setTone(pct) {
    this.aTone = this.toneCoef(pct);
  }

  /** MOD:调制深度 %(0~100 → 0~±2.5ms,0.9Hz 正弦) */
  setMod(pct) {
    this.modDepth = (Math.min(100, Math.max(0, pct)) / 100) * ((MOD_MAX_MS * this.fs) / 1000);
  }

  /** MIX:湿声比例 %(0~100 → 0~1,干声恒 1) */
  setMix(pct) {
    this.mix = Math.min(1, Math.max(0, pct / 100));
  }

  process(x) {
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

/**
 * BBD 模拟延迟全链路引擎。process(inputs, outputs, params) 语义与
 * AudioWorkletProcessor.process 一致;采样率由构造注入(替代 worklet 全局
 * sampleRate),引擎内不含任何 AudioWorklet API。每通道独立延迟线状态;
 * 全部参数为 k-rate,变化做脏检查缓存(this.last)。
 */
export class BbdAnalogDelayEngine {
  /** @param {number} sampleRate 采样率 */
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    /** @type {BbdAnalogDelay[]} 每通道独立延迟核 */
    this.chains = [];
    this.last = { time: -1, feedback: -1, tone: -1, mod: -1, mix: -1 };
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    while (this.chains.length < input.length) {
      this.chains.push(new BbdAnalogDelay(this.sampleRate));
    }

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
