/**
 * WDF Champ(5F1 风格)实验箱头 DSP 核——单一来源(ADR-0003)。
 *
 * 链路:
 *   输入 → drive(GAIN)→ 12AX7 级 1(Rk820 无旁路,冷偏置 bright)
 *   → 级间衰减 → 12AX7 级 2(全旁路)
 *   → 6V6 单端后级(近似 Koren 功率管)→ 输出变压器(80Hz HP + 6.5kHz LP)
 *   → MASTER → 输出
 *   内部 4x 过采样(resample.dsp.js)。每通道独立链路状态。
 *
 * 双模式消费:worklet 经 `?raw` 取源码字符串拼装 Blob;eval/测试直接 import。
 * 只用单行 import 与内联 export(buildProcessorSource 依赖此约定剥离)。
 */
import { TriodeStage, KOREN_6V6_APPROX } from './triode.dsp.js';
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from './resample.dsp.js';

/**
 * Champ 全链路引擎。process(inputs, outputs, params) 语义与
 * AudioWorkletProcessor.process 一致;采样率由构造注入(替代 worklet 全局
 * sampleRate),引擎内不含任何 AudioWorklet API。
 */
export class WdfChampEngine {
  /** @param {number} sampleRate 基率采样率(引擎内部自行 ×OS_FACTOR) */
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.fir = makeAntiAliasFIR();
    /** @type {object[]} 每通道独立链路状态 */
    this.chains = [];
  }

  createChain() {
    const fs = this.sampleRate * OS_FACTOR;
    return {
      st1: new TriodeStage(fs, { Rk: 820, Ck: 0, Rs: 68e3 }),
      st2: new TriodeStage(fs, { Rs: 100e3 }),
      pw: new TriodeStage(fs, {
        koren: KOREN_6V6_APPROX, Bplus: 285, Rp: 5e3, Rk: 250, Ck: 0,
        Co: 1e-3, Rload: 1e6, Rs: 220e3,
      }),
      up: new Upsampler4x(this.fir),
      down: new Decimator4x(this.fir),
      xfHpX1: 0, xfHpY1: 0, xfLpY1: 0,
    };
  }

  transformer(c, x) {
    const fs = this.sampleRate * OS_FACTOR;
    const T = 1 / fs;
    const rcHp = 1 / (2 * Math.PI * 80);
    const aHp = rcHp / (rcHp + T);
    const yHp = aHp * (c.xfHpY1 + x - c.xfHpX1);
    c.xfHpX1 = x;
    c.xfHpY1 = yHp;
    const rcLp = 1 / (2 * Math.PI * 6500);
    const aLp = T / (rcLp + T);
    c.xfLpY1 = c.xfLpY1 + aLp * (yHp - c.xfLpY1);
    return c.xfLpY1;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    while (this.chains.length < input.length) this.chains.push(this.createChain());

    const drive = 1 + (params.gain[0] / 100) * 29;
    const master = params.master[0]; // 线性增益,外层已做 dB 转换
    const osIn = new Float32Array(OS_FACTOR);
    const osOut = new Float32Array(OS_FACTOR);

    for (let ch = 0; ch < input.length; ch++) {
      const c = this.chains[ch];
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) {
        c.up.process(osIn, inp[i]);
        for (let k = 0; k < OS_FACTOR; k++) {
          const s1 = c.st1.process(osIn[k] * drive);
          const s2 = c.st2.process(s1 * 0.08);
          const p = c.pw.process(s2 * 0.25);
          osOut[k] = this.transformer(c, p) / 250;
        }
        out[i] = c.down.process(osOut[0], osOut[1], osOut[2], osOut[3]) * master;
      }
    }
    return true;
  }
}
