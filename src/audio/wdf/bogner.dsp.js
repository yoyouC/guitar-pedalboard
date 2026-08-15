/**
 * WDF Bogner(Ecstasy 高增益通道风格)实验箱头 DSP 核——单一来源(ADR-0003)。
 *
 * 链路:
 *   输入 → 130Hz 高通(紧实低频)→ drive(GAIN)
 *   → 12AX7 级 1(2.7k + 0.68uF 部分旁路,中高频前倾)
 *   → 级 2(10k 无旁路,冷偏置,不对称削波)
 *   → 级 3(820 + 22uF 全旁路,热增益)
 *   → EL34 推挽后级(近似 Koren)→ 输出变压器(90Hz HP + 6kHz LP)→ 输出
 *   内部 4x 过采样(resample.dsp.js)。每通道独立链路状态。
 *
 * 双模式消费:worklet 经 `?raw` 取源码字符串拼装 Blob;eval/测试直接 import。
 * 只用单行 import 与内联 export(buildProcessorSource 依赖此约定剥离)。
 * 权威来源(issue #7):以原 bognerWorklet.ts 内联版(用户实际听到的)为准
 * 逐表达式平移;三极管级与重采样审计逐字符等同于共享核,改为 import
 * triode.dsp.js(TriodeStage/KOREN_EL34_APPROX)与 resample.dsp.js。
 */
import { TriodeStage, KOREN_EL34_APPROX } from './triode.dsp.js';
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from './resample.dsp.js';

/**
 * Bogner 全链路引擎。process(inputs, outputs, params) 语义与
 * AudioWorkletProcessor.process 一致;采样率由构造注入(替代 worklet 全局
 * sampleRate),引擎内不含任何 AudioWorklet API。
 */
export class WdfBognerEngine {
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
      st1: new TriodeStage(fs, { Rk: 2.7e3, Ck: 0.68e-6, Rs: 34e3 }),
      st2: new TriodeStage(fs, { Rk: 10e3, Ck: 0, Rs: 100e3 }),
      st3: new TriodeStage(fs, { Rk: 820, Ck: 22e-6, Rs: 100e3 }),
      pw: new TriodeStage(fs, {
        koren: KOREN_EL34_APPROX, Bplus: 350, Rp: 4e3, Rk: 250, Ck: 0,
        Co: 1e-3, Rload: 1e6, Rs: 220e3,
      }),
      up: new Upsampler4x(this.fir),
      down: new Decimator4x(this.fir),
      hpIn: { x1: 0, y1: 0 },   // 输入 130Hz 高通
      xfHp: { x1: 0, y1: 0 },   // 变压器 90Hz 高通
      xfLpY1: 0,
    };
  }

  onePoleHp(st, x, fc) {
    const T = 1 / (this.sampleRate * OS_FACTOR);
    const rc = 1 / (2 * Math.PI * fc);
    const a = rc / (rc + T);
    const y = a * (st.y1 + x - st.x1);
    st.x1 = x;
    st.y1 = y;
    return y;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    while (this.chains.length < input.length) this.chains.push(this.createChain());

    const drive = 1 + (params.gain[0] / 100) * 39;
    const osIn = new Float32Array(OS_FACTOR);
    const osOut = new Float32Array(OS_FACTOR);
    const T = 1 / (this.sampleRate * OS_FACTOR);
    const rcLp = 1 / (2 * Math.PI * 6000);
    const aLp = T / (rcLp + T);

    for (let ch = 0; ch < input.length; ch++) {
      const c = this.chains[ch];
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) {
        c.up.process(osIn, inp[i]);
        for (let k = 0; k < OS_FACTOR; k++) {
          const x = this.onePoleHp(c.hpIn, osIn[k], 130);
          const s1 = c.st1.process(x * drive);
          const s2 = c.st2.process(s1 * 0.06);
          const s3 = c.st3.process(s2 * 0.10);
          const p = c.pw.process(s3 * 0.22);
          const y = this.onePoleHp(c.xfHp, p, 90);
          c.xfLpY1 = c.xfLpY1 + aLp * (y - c.xfLpY1);
          osOut[k] = c.xfLpY1 / 250;
        }
        out[i] = c.down.process(osOut[0], osOut[1], osOut[2], osOut[3]);
      }
    }
    return true;
  }
}
