/**
 * WDF JC-120(Roland Jazz Chorus 风格,全固态极致清音)DSP 核——单一来源(ADR-0003)。
 *
 * 链路(无电子管,全部线性件用梯形/单极点伴随模型离散):
 *   输入 → 30Hz 输入耦合 HP
 *        → 运放线性增益级:drive = 2 + (GAIN/100)·18(2..20 倍),
 *          电源轨软饱和 15·tanh(v/15)(小信号增益精确 = drive,极端输入才进入软削)
 *        → 固态后级:固定 ×2,深度 tanh 兜底 25·tanh(v/25)(超大动态余量)
 *        → 扬声器带宽:50Hz HP + 8kHz LP(单极点,无输出变压器)
 *        → /NORM 归一化
 *   (基率)可选 CHORUS:0.45Hz 三角波 LFO 调制 5ms±2.5ms 延迟 + 干湿混合,
 *   立体声 LFO 相位按通道错开 1/4 周期。
 *   内部 4x 过采样(resample.dsp.js)。每通道独立链路状态。
 *
 * 全链非线性均为显式无记忆 tanh(串联、无反馈耦合),不需要隐式 Newton——
 * 显式求值即精确解,这是与三极管级(隐式 Koren 方程)的本质区别。
 *
 * 双模式消费:worklet 经 `?raw` 取源码字符串拼装 Blob;eval/测试直接 import。
 * 只用单行 import 与内联 export(buildProcessorSource 依赖此约定剥离)。
 * 权威来源(issue #7):以原 jc120Worklet.ts 内联版为准(审计:与旧
 * jc120Core.ts 逐行一致,仅封装形态差异——core 闭包滤波器 vs 内联预算
 * 系数,取内联形态);jc120Nonlin 为 core 独有的静态传输核(eval L1 用),
 * 从 core 平移。
 */
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from './resample.dsp.js';

export const JC120 = {
  /** 输入耦合 HP 转角(Hz) */
  HP_IN: 30,
  /** 运放电源轨软饱和电压(V) */
  RAIL_PRE: 15,
  /** 前置增益行程:drive = PRE_MIN + (gain/100)·PRE_SPAN */
  PRE_MIN: 2,
  PRE_SPAN: 18,
  /** 后级固定增益 */
  POWER_GAIN: 2,
  /** 后级深度软削兜底电压(V) */
  RAIL_POWER: 25,
  /** 扬声器 HP/LP 转角(Hz) */
  SPK_HP: 50,
  SPK_LP: 8000,
  /** 输出归一化(内部"电压"→ 数字电平) */
  NORM: 12,
  /** 合唱:三角波 LFO 速率(Hz)、中心延迟(ms)、调制深度(±ms)、湿声比例 */
  CHORUS_RATE: 0.45,
  CHORUS_CENTER_MS: 5,
  CHORUS_DEPTH_MS: 2.5,
  CHORUS_MIX: 0.5,
};

/** GAIN 旋钮(0~100)→ 运放级线性增益倍数 */
export function jc120Drive(gainPct) {
  return JC120.PRE_MIN + (gainPct / 100) * JC120.PRE_SPAN;
}

/**
 * 静态传输核(无滤波器的纯静态曲线,L1 用):
 * v = RAIL_POWER·tanh(POWER_GAIN·RAIL_PRE·tanh(x·drive/RAIL_PRE)/RAIL_POWER)/NORM
 */
export function jc120Nonlin(x, drive) {
  const v1 = JC120.RAIL_PRE * Math.tanh((x * drive) / JC120.RAIL_PRE);
  return (JC120.RAIL_POWER * Math.tanh((JC120.POWER_GAIN * v1) / JC120.RAIL_POWER)) / JC120.NORM;
}

/** 清音主链(过采样域,每通道一个实例) */
export class Jc120Core {
  /** @param {number} fs 过采样域采样率 */
  constructor(fs) {
    this.T = 1 / fs;
    this.drive = JC120.PRE_MIN + 0.4 * JC120.PRE_SPAN;
    // 单极点 HP 状态:a = rc/(rc+T)
    const rcIn = 1 / (2 * Math.PI * JC120.HP_IN);
    this.aHpIn = rcIn / (rcIn + this.T);
    this.inX1 = 0; this.inY1 = 0;
    const rcSpk = 1 / (2 * Math.PI * JC120.SPK_HP);
    this.aSpkHp = rcSpk / (rcSpk + this.T);
    this.spX1 = 0; this.spY1 = 0;
    // 单极点 LP:a = T/(rc+T)
    const rcLp = 1 / (2 * Math.PI * JC120.SPK_LP);
    this.aSpkLp = this.T / (rcLp + this.T);
    this.lpY1 = 0;
  }
  setGain(gainPct) {
    this.drive = JC120.PRE_MIN + (gainPct / 100) * JC120.PRE_SPAN;
  }
  /** 处理一个 OS 域样本,返回归一化输出 */
  processOs(x) {
    // 输入耦合 HP 30Hz
    let y = this.aHpIn * (this.inY1 + x - this.inX1);
    this.inX1 = x;
    this.inY1 = y;
    // 运放线性增益级 + 15V 轨软饱和
    const v1 = JC120.RAIL_PRE * Math.tanh((y * this.drive) / JC120.RAIL_PRE);
    // 固态后级 ×2 + 25V 深度 tanh 兜底
    const v2 = JC120.RAIL_POWER * Math.tanh((JC120.POWER_GAIN * v1) / JC120.RAIL_POWER);
    // 扬声器 50Hz HP
    y = this.aSpkHp * (this.spY1 + v2 - this.spX1);
    this.spX1 = v2;
    this.spY1 = y;
    // 扬声器 8kHz LP
    this.lpY1 = this.lpY1 + this.aSpkLp * (y - this.lpY1);
    return this.lpY1 / JC120.NORM;
  }
}

/**
 * JC 标志性立体声合唱(基率,每通道一个实例):
 * 0.45Hz 三角波 LFO 调制 5ms±2.5ms 延迟,干湿 50/50 混合;
 * 通道间 LFO 相位错开(立体声宽度),phase0 由调用方按通道号给。
 * CHORUS 为开关参数(0/1),mix 平滑过渡防爆音;off 时输出精确等于干声。
 */
export class Jc120Chorus {
  /**
   * @param {number} fs 基率采样率
   * @param {number} [phase0] LFO 初相(0..1 周期),默认 0;立体声按 chIndex*0.25 错开
   */
  constructor(fs, phase0 = 0) {
    this.fs = fs;
    let len = 1;
    while (len < fs * 0.02) len <<= 1; // ≥20ms,2 的幂
    this.buf = new Float32Array(len);
    this.mask = len - 1;
    this.w = 0;
    this.phase = phase0 - Math.floor(phase0);
    this.target = 0;
    this.mix = 0;
  }
  /** 0/1 开关 */
  setOn(on) {
    this.target = on > 0.5 ? JC120.CHORUS_MIX : 0;
  }
  process(x) {
    if (this.mix < 1e-6 && this.target === 0) {
      this.w = (this.w + 1) & this.mask;
      this.buf[this.w] = x;
      this.phase += JC120.CHORUS_RATE / this.fs;
      if (this.phase >= 1) this.phase -= 1;
      return x;
    }
    this.w = (this.w + 1) & this.mask;
    this.buf[this.w] = x;
    const tri = this.phase < 0.5 ? 4 * this.phase - 1 : 3 - 4 * this.phase;
    const d = ((JC120.CHORUS_CENTER_MS + JC120.CHORUS_DEPTH_MS * tri) / 1000) * this.fs;
    const r = this.w - d;
    const i0 = Math.floor(r);
    const frac = r - i0;
    const a = this.buf[i0 & this.mask];
    const wet = a + (this.buf[(i0 + 1) & this.mask] - a) * frac;
    this.phase += JC120.CHORUS_RATE / this.fs;
    if (this.phase >= 1) this.phase -= 1;
    this.mix += 0.002 * (this.target - this.mix);
    return x * (1 - this.mix) + wet * this.mix;
  }
}

/**
 * JC-120 全链路引擎。process(inputs, outputs, params) 语义与
 * AudioWorkletProcessor.process 一致;采样率由构造注入(替代 worklet 全局
 * sampleRate),引擎内不含任何 AudioWorklet API。
 */
export class WdfJc120Engine {
  /** @param {number} sampleRate 基率采样率(引擎内部自行 ×OS_FACTOR) */
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.fir = makeAntiAliasFIR();
    /** @type {object[]} 每通道独立链路状态 */
    this.chains = [];
  }

  createChain(chIndex) {
    const fsOs = this.sampleRate * OS_FACTOR;
    return {
      core: new Jc120Core(fsOs),
      // 立体声合唱:LFO 相位按通道错开 1/4 周期(右声道正交)
      chorus: new Jc120Chorus(this.sampleRate, chIndex * 0.25),
      up: new Upsampler4x(this.fir),
      down: new Decimator4x(this.fir),
    };
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    while (this.chains.length < input.length) {
      this.chains.push(this.createChain(this.chains.length));
    }
    const gain = params.gain[0];
    const chorusOn = params.chorus[0];
    const osIn = new Float32Array(OS_FACTOR);
    const osOut = new Float32Array(OS_FACTOR);
    for (let ch = 0; ch < input.length; ch++) {
      const c = this.chains[ch];
      c.core.setGain(gain);
      c.chorus.setOn(chorusOn);
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) {
        c.up.process(osIn, inp[i]);
        for (let k = 0; k < OS_FACTOR; k++) osOut[k] = c.core.processOs(osIn[k]);
        out[i] = c.chorus.process(c.down.process(osOut[0], osOut[1], osOut[2], osOut[3]));
      }
    }
    return true;
  }
}
