/**
 * WDF 版 Boss DS-1 削波单块 DSP 核——单一来源(ADR-0003)。
 *
 * 链路(ElectroSmash DS-1 元件值,全部在 4x 过采样域):
 *   输入 → 输入耦合 HP(C1 22n × R1 470k = 15.4Hz)
 *   → BJT 前级简化:固定增益 5 + Vsat=2V tanh 温和软削
 *   → 运放可变增益级(Z1 = R12 4.7k + C8 0.47u → 72Hz HP;反馈 Rf=2.2k+100k·DIST || C7 100p)
 *   → 1N4148 反并联对地削波(R17 2.2k,Rload 4.7k 为音色网络等效负载,每样本 Newton)
 *   → TONE:LP(723Hz,R19·C15)/ HP(7.2kHz,C14·R20)交叉淡化(中位中频凹陷)
 *   → LEVEL(线性,dB 域由外层转换)→ 输出
 *   内部 4x 过采样(resample.dsp.js)。每通道独立链路状态。
 *
 * 削波级求解(每样本):
 *   1) Z1 支路电流 i1(串联 R12-C8,线性,梯形精确解)
 *   2) 反馈电压 vf = (i1 - ih7) / (1/Rf + G7)(线性),vOp = vin + vf
 *   3) Newton 解削波节点 vd:F(vd) = 2·Is·sinh(vd/nVt) + vd·(1/R17+1/Rload) - vOp/R17
 *
 * 与 TS808 的结构差异:二极管在输出节点对地(硬削波),而非反馈回路内,
 * 因此削波节点是"软"节点,负载电流进入 Newton 方程。
 *
 * 双模式消费:worklet(ds1Worklet.ts)经 `?raw` 取源码字符串拼装 Blob;
 * eval/测试直接 import。只用单行 import 与内联 export(buildProcessorSource
 * 依赖此约定剥离模块语法)。以原 worklet 内联版(用户实际听到的代码)为权威
 * 逐表达式平移;求解器统计(iterTotal/iterCount)以附加字段保留,不影响数值。
 */
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from './resample.dsp.js';

/** 1N4148 二极管参数(WDF 文献标准值:chowdsp / Yeh 论文,与 diodeClipper.dsp.js 一致) */
export const DIODE_1N4148 = { Is: 2.52e-9, nVt: 1.752 * 25.85e-3 };

export class Ds1ClipperStage {
  /** @param {number} fs 采样率(含过采样倍率后的实际速率) */
  constructor(fs) {
    this.T = 1 / fs;
    this.R12 = 4.7e3;
    this.C8 = 0.47e-6;
    this.G7 = (2 * 100e-12) / this.T;
    this.Rf = 2.2e3 + 50e3;
    this.G17 = 1 / 2.2e3;
    this.Gload = 1 / 4.7e3;
    this.vc8 = 0;
    this.i1Prev = 0;
    this.ih7 = 0;
    this.vdPrev = 0;
    /** 求解器统计(评测用,不影响数值) */
    this.iterTotal = 0;
    this.iterCount = 0;
  }

  /** dist 0~1 → Rf = 2.2k + 100k·dist(DS-1 中频增益 1+Rf/R12 ≈ 1.47~22.7) */
  setDist(d) {
    this.Rf = 2.2e3 + 100e3 * Math.min(1, Math.max(0, d));
  }

  /** vBst:BJT 前级输出(链内已做固定增益+tanh 软削)。返回削波节点电压。 */
  process(vBst) {
    const a = this.T / (2 * this.C8);
    const i1 = (vBst - this.vc8 - a * this.i1Prev) / (this.R12 + a);
    this.vc8 += a * (i1 + this.i1Prev);
    this.i1Prev = i1;

    const gZf = 1 / this.Rf + this.G7;
    const vf = (i1 - this.ih7) / gZf;
    const iC7 = this.G7 * vf + this.ih7;
    this.ih7 = -this.G7 * vf - iC7;
    const vOp = vBst + vf;

    const { Is, nVt } = DIODE_1N4148;
    const gSum = this.G17 + this.Gload;
    const src = vOp * this.G17;
    let vd = this.vdPrev;
    let iter = 0;
    for (; iter < 12; iter++) {
      const f = 2 * Is * Math.sinh(vd / nVt) + vd * gSum - src;
      if (Math.abs(f) < 1e-12) break;
      const df = ((2 * Is) / nVt) * Math.cosh(vd / nVt) + gSum;
      let step = f / df;
      if (step > 0.2) step = 0.2;
      else if (step < -0.2) step = -0.2;
      vd -= step;
      if (vd > 1.0) vd = 1.0;
      else if (vd < -1.0) vd = -1.0;
    }
    this.iterTotal += iter;
    this.iterCount++;
    this.vdPrev = vd;
    return vd;
  }
}

/**
 * DS-1 全链路引擎。process(inputs, outputs, params) 语义与
 * AudioWorkletProcessor.process 一致;采样率由构造注入(替代 worklet 全局
 * sampleRate),引擎内不含任何 AudioWorklet API。
 */
export class WdfDs1Engine {
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
      stage: new Ds1ClipperStage(fs),
      up: new Upsampler4x(this.fir),
      down: new Decimator4x(this.fir),
      hpInY1: 0,   // 15.4Hz 输入耦合 HP 的低通状态
      toneLpY1: 0, // 723Hz LP 支路
      toneHpY1: 0, // 7.2kHz LP 状态(HP 支路 = x - LP)
      lastDist: -1,
    };
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    while (this.chains.length < input.length) this.chains.push(this.createChain());

    const T = 1 / (this.sampleRate * OS_FACTOR);
    const aHpIn = T / (470e3 * 0.022e-6 + T);   // C1·R1 → 15.4Hz
    const aToneLp = T / (2.2e3 * 0.1e-6 + T);   // R19·C15 → 723Hz LP
    const aToneHp = T / (2.2e3 * 0.01e-6 + T);  // C14·R20 → 7.2kHz HP(经 x - LP 实现)
    // tone 0~100 → LP/HP 交叉淡化比(0= LP 暗,1= HP 亮,中位中频凹陷)
    const t = params.tone[0] / 100;
    const level = params.level[0];
    const dist = params.dist[0] / 100;
    const osIn = new Float32Array(OS_FACTOR);
    const osOut = new Float32Array(OS_FACTOR);

    for (let ch = 0; ch < input.length; ch++) {
      const c = this.chains[ch];
      if (c.lastDist !== dist) {
        c.stage.setDist(dist);
        c.lastDist = dist;
      }
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) {
        c.up.process(osIn, inp[i]);
        for (let k = 0; k < OS_FACTOR; k++) {
          // 输入耦合 HP(x - LP)
          c.hpInY1 += aHpIn * (osIn[k] - c.hpInY1);
          const hp = osIn[k] - c.hpInY1;
          // BJT 前级简化:固定增益 5 + Vsat=2V tanh 温和软削
          const bst = 2.0 * Math.tanh(2.5 * hp);
          // 运放可变增益 + 对地二极管削波
          const s = c.stage.process(bst);
          // TONE 交叉淡化:LP(723Hz) 与 HP(7.2kHz)
          c.toneLpY1 += aToneLp * (s - c.toneLpY1);
          c.toneHpY1 += aToneHp * (s - c.toneHpY1);
          osOut[k] = (1 - t) * c.toneLpY1 + t * (s - c.toneHpY1);
        }
        out[i] = c.down.process(osOut[0], osOut[1], osOut[2], osOut[3]) * level;
      }
    }
    return true;
  }
}
