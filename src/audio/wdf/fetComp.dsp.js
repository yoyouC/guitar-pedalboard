/**
 * FET 压缩(1176 风格)DSP 核——单一来源(ADR-0003)。
 *
 * 链路(每通道一个 FetCompressor 实例):
 *   输入 → 峰值检测(|x|,瞬时)→ 电平 dB → 增益计算机(硬拐点,前馈,
 *   4/8/12/20:1 / ALL 压限)→ GR 包络(dB 域单极点:ATTACK 20~800µs /
 *   RELEASE 50~1100ms,1176 规格)→ 线性增益级 → FET 输出级饱和
 *  (tanh 软饱和 + 平方律偶次项,4x 过采样 + 48 阶 FIR 抗混叠,
 *   resample.dsp.js)→ LEVEL → 输出。
 *   饱和驱动随 GR 加深(drive = 1 + 0.4·grDb):深压缩下失真明显增加,
 *   阈下保持近透明。
 *
 * 双模式消费:worklet(fet1176Worklet.ts)经 `?raw` 取源码字符串拼装 Blob;
 * eval/测试直接 import。只用单行 import 与内联 export
 * (buildProcessorSource 依赖此约定剥离模块语法)。
 * 本文件以原 worklet 内联版为权威逐表达式平移(issue #7,音色零变化);
 * 过采样改用共享核 resample.dsp.js(与内联 Up4/Down4/makeFIR 逐行等价)。
 */
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from './resample.dsp.js';

const LN10_OVER_20 = Math.log(10) / 20;
const DB_FLOOR = 1e-7;
const RATIO_STEPS = [4, 8, 12, 20, Infinity];

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 单通道 1176 风格 FET 压缩核心(每样本 process(x) → y)。
 * 逐表达式平移自原 worklet 内联 FetCompCore;采样率由构造注入。
 */
export class FetCompressor {
  /** @param {number} fs 采样率 */
  constructor(fs) {
    this.fs = fs;
    this.thresholdDb = -20;
    this.slope = 1 - 1 / 8;
    this.attackCoef = 0;
    this.releaseCoef = 0;
    this.levelGain = 1;
    this.satK = 0.5;
    this.satBeta = 0.06;
    this.gr = 0;
    const fir = makeAntiAliasFIR();
    this.up = new Upsampler4x(fir);
    this.down = new Decimator4x(fir);
    this.osBuf = new Float32Array(OS_FACTOR);
    this.setRatioIndex(1);
    this.setAttackUs(200);
    this.setReleaseMs(250);
  }

  /** 当前增益衰减(dB,表桥/评测用) */
  get grDb() {
    return this.gr;
  }

  setThresholdDb(v) {
    this.thresholdDb = clamp(v, -60, 0);
  }

  /** RATIO 档 0..4 → 4/8/12/20:1/ALL */
  setRatioIndex(i) {
    const idx = clamp(Math.round(i), 0, RATIO_STEPS.length - 1);
    const R = RATIO_STEPS[idx];
    if (R === Infinity) {
      this.slope = 1;
      this.satK = 1.2;
      this.satBeta = 0.25;
    } else {
      this.slope = 1 - 1 / R;
      this.satK = 0.5;
      this.satBeta = 0.06;
    }
  }

  setAttackUs(us) {
    const tau = clamp(us, 20, 800) * 1e-6;
    this.attackCoef = 1 - Math.exp(-1 / (this.fs * tau));
  }

  setReleaseMs(ms) {
    const tau = clamp(ms, 50, 1100) * 1e-3;
    this.releaseCoef = 1 - Math.exp(-1 / (this.fs * tau));
  }

  /** LEVEL:线性增益(dB 域由外层转换后传入);实现侧 clamp 到 0..4(宽于 descriptor 的 0..2,以原内联版为准) */
  setLevelGain(g) {
    this.levelGain = clamp(g, 0, 4);
  }

  /** FET 输出级饱和:平方律偶次项 + tanh 软饱和,小信号增益 1 */
  sat(u) {
    return Math.tanh(this.satK * (u + this.satBeta * u * u)) / this.satK;
  }

  process(x) {
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

/**
 * FET1176 全链路引擎。process(inputs, outputs, params) 语义与
 * AudioWorkletProcessor.process 一致;采样率由构造注入(替代 worklet 全局
 * sampleRate),引擎内不含任何 AudioWorklet API。每通道独立 FetCompressor。
 */
export class WdfFet1176Engine {
  /** @param {number} sampleRate 采样率 */
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    /** @type {FetCompressor[]} 每通道独立压缩核 */
    this.chains = [];
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    while (this.chains.length < input.length) {
      this.chains.push(new FetCompressor(this.sampleRate));
    }

    for (let ch = 0; ch < input.length; ch++) {
      const c = this.chains[ch];
      c.setThresholdDb(params.threshold[0]);
      c.setRatioIndex(params.ratio[0]);
      c.setAttackUs(params.attack[0]);
      c.setReleaseMs(params.release[0]);
      c.setLevelGain(params.level[0]);
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) out[i] = c.process(inp[i]);
    }
    return true;
  }
}
