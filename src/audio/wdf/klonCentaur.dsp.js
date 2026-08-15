/**
 * WDF 版 Klon Centaur DSP 核——单一来源(ADR-0003)。
 *
 * 链路:
 *   输入 → 运放增益级(g = 10^(GAIN·46/20),1x~200x)
 *   → WDF 削波级(5.6k 串联 + 反并联 1N34A 锗管对地,每样本 Newton)
 *   → 干湿混合(双联 GAIN 电位器:低增益干声为主,即"透明"感)
 *   → TREBLE 高架(3kHz,±10dB)→ LEVEL(线性,dB 域由外层转换)→ 输出
 *   内部 4x 过采样(resample.dsp.js)。每通道独立链路状态。
 *
 * 双模式消费:worklet(klonWorklet.ts)经 `?raw` 取本文件源码字符串,
 * 与 wrapper 拼装进 Blob;eval/测试直接 import。只用单行 import 与内联 export
 * (buildProcessorSource 依赖此约定剥离模块语法)。
 * 本文件以 worklet 内联版为权威逐表达式平移(issue #7;音色零变化):
 * klonGainForKnob/klonDryCoeff 不做钳位(内联版靠 descriptor 0~100 保证范围,
 * 已删除的 core 版有 clamp01——以内联版为准);削波级可选 opts 注入与
 * iterTotal/iterCount 统计为评测用附加,默认值与内联硬编码一致。
 */
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from './resample.dsp.js';

/** 1N34A 类锗二极管参数(文献值:Is≈1µA,nVt≈34mV,Vf≈0.3V) */
export const DIODE_1N34A = { Is: 1e-6, nVt: 0.034 };

/** 锗管反并联对地削波级:运放输出 vo 经 Rser 馈入,vd 为削波节点电压 */
export class KlonClipperStage {
  /**
   * @param {{ Rser?: number, Rload?: number, diode?: { Is: number, nVt: number } }} [opts]
   *   可选注入(评测用);默认值与内联硬编码一致
   */
  constructor(opts = {}) {
    this.Rser = opts.Rser ?? 5.6e3;
    this.Rload = opts.Rload ?? 27e3;
    this.diode = opts.diode ?? DIODE_1N34A;
    this.vdPrev = 0;
    /** 求解器统计(评测用) */
    this.iterTotal = 0;
    this.iterCount = 0;
  }

  process(vo) {
    const { Is, nVt } = this.diode;
    const gLeak = 1 / this.Rser + 1 / this.Rload;
    const iSrc = vo / this.Rser;
    let vd = this.vdPrev;
    let iter = 0;
    for (; iter < 12; iter++) {
      const f = 2 * Is * Math.sinh(vd / nVt) + vd * gLeak - iSrc;
      if (Math.abs(f) < 1e-12) break;
      const df = ((2 * Is) / nVt) * Math.cosh(vd / nVt) + gLeak;
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

/** GAIN 旋钮 0~1 → 运放增益级增益(1x~200x,0~46dB 指数锥度) */
export function klonGainForKnob(knob) {
  return Math.pow(10, (knob * 46) / 20);
}

/**
 * GAIN 旋钮 0~1 → 干声权重(双联电位器 B 联:p = 1-knob 的分压,
 * 源阻抗 p·(1-p)·Rpot 与求和电阻负载效应一并计入)。
 */
export function klonDryCoeff(knob) {
  const p = 1 - knob;
  return (27e3 * p) / (p * (1 - p) * 100e3 + 27e3);
}

/**
 * Klon Centaur 全链路引擎。process(inputs, outputs, params) 语义与
 * AudioWorkletProcessor.process 一致;采样率由构造注入(替代 worklet 全局
 * sampleRate,原内联版在 process() 内每块用它算 TREBLE 系数),
 * 引擎内不含任何 AudioWorklet API。
 */
export class WdfKlonEngine {
  /** @param {number} sampleRate 基率采样率(引擎内部自行 ×OS_FACTOR) */
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.fir = makeAntiAliasFIR();
    /** @type {object[]} 每通道独立链路状态 */
    this.chains = [];
  }

  createChain() {
    return {
      clipper: new KlonClipperStage(),
      up: new Upsampler4x(this.fir),
      down: new Decimator4x(this.fir),
      toneLpY1: 0, // TREBLE 高架的低通分量
    };
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    while (this.chains.length < input.length) this.chains.push(this.createChain());

    const T = 1 / (this.sampleRate * OS_FACTOR);
    // treble 0~100 → 高架 -10 ~ +10dB(dB 镜像对称:衰减时转角下移至 fc·G)
    const trebleDb = ((params.treble[0] - 50) / 50) * 10;
    const toneG = Math.pow(10, trebleDb / 20);
    const fcShelf = toneG >= 1 ? 3000 : 3000 * toneG;
    const aTone = T / (1 / (2 * Math.PI * fcShelf) + T);
    const level = params.level[0];
    const knob = params.gain[0] / 100;
    // 运放增益级:1x~200x(0~46dB 指数锥度)
    const g = klonGainForKnob(knob);
    // 双联电位器 B 联干声权重:p = 1-knob 分压 + 求和电阻负载
    const dryW = klonDryCoeff(knob);
    const osIn = new Float32Array(OS_FACTOR);
    const osOut = new Float32Array(OS_FACTOR);

    for (let ch = 0; ch < input.length; ch++) {
      const c = this.chains[ch];
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) {
        c.up.process(osIn, inp[i]);
        for (let k = 0; k < OS_FACTOR; k++) {
          const vd = c.clipper.process(g * osIn[k]);
          const sum = vd + dryW * osIn[k];
          // TREBLE 高架(一阶):low + g·(x - low)
          c.toneLpY1 += aTone * (sum - c.toneLpY1);
          osOut[k] = c.toneLpY1 + toneG * (sum - c.toneLpY1);
        }
        out[i] = c.down.process(osOut[0], osOut[1], osOut[2], osOut[3]) * level;
      }
    }
    return true;
  }
}
