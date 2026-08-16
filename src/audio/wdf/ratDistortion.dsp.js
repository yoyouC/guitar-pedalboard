/**
 * WDF 版 Pro Co RAT 削波单块 DSP 核——单一来源(ADR-0003)。
 *
 * 链路:
 *   输入 → WDF 失真级(可变增益运放:1.5kHz 反馈高通 + LM308 摆率 5.3kHz 低通,
 *   R5 + 反并联 1N914 对地硬削波,DIST)→ FILTER 反向单极点低通
 *   (475Hz 顺时 ~ 32kHz 逆时,与削波节点联立求解)→ LEVEL(线性,dB 域由外层转换)→ 输出
 *   内部 4x 过采样(resample.dsp.js)。每通道独立链路状态。
 *
 * 失真级求解(每样本):
 *   1) 增益网络 Z1(串联 R3-C3)支路电流 i1:线性,梯形精确解
 *   2) 5.3kHz 双线性一阶低通(系数构造时预算)
 *   3) Newton 解削波节点 Vd:
 *        F(Vd) = (Vd-v2)/R5 + 2·Is·sinh(Vd/nVt) + iFilt(Vd) = 0
 *      其中 iFilt(Vd) = (Vd - vc6 - a6·iFiltPrev)/(Rfilt + a6) 为 FILTER
 *      串联 RC 支路电流(Vd 的线性函数),解析 Jacobian。
 *      该支路对削波节点有真实负载效应,故必须联立求解而非事后滤波。
 *   4) 梯形更新 C6 状态,输出 = V(C6)
 *
 * 双模式消费:worklet(ratWorklet.ts)经 `?raw` 取源码字符串拼装 Blob;
 * eval/测试直接 import。只用单行 import 与内联 export(buildProcessorSource
 * 依赖此约定剥离模块语法)。以原 worklet 内联版(用户实际听到的代码)为权威
 * 逐表达式平移;已删除的 ratDistortion.ts 的 options 注入未保留(eval 脚本
 * 未使用),求解器统计(iterTotal/iterCount)以附加字段保留,不影响数值。
 */
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from './resample.dsp.js';

/** 1N914 硅二极管参数(与 1N4148 同族,WDF 文献标准值:chowdsp / Yeh 论文) */
export const DIODE_1N914 = { Is: 2.52e-9, nVt: 1.752 * 25.85e-3 };

/** FILTER 旋钮行程(实测电路):0 = 逆时到底(32kHz,最亮),100 = 顺时到底(475Hz,最暗) */
export const FILTER_MAX_HZ = 32000;
export const FILTER_MIN_HZ = 475;

/** FILTER 旋钮 0~100 → 截止频率(反向,对数行程) */
export function filterToFreq(v) {
  const t = Math.min(100, Math.max(0, v)) / 100;
  return FILTER_MAX_HZ * Math.pow(FILTER_MIN_HZ / FILTER_MAX_HZ, t);
}

export class RatStage {
  /** @param {number} fs 采样率(含过采样倍率后的实际速率) */
  constructor(fs) {
    this.T = 1 / fs;
    this.R3 = 47;
    this.C3 = 2.2e-6;
    this.G5 = 1 / 1e3;
    this.C6 = 3.3e-9;
    this.a6 = this.T / (2 * this.C6);
    // LM308 摆率软化(5.3kHz 双线性一阶低通),系数构造时预算
    const rc = 1 / (2 * Math.PI * 5300);
    const k = (2 * rc) / this.T;
    this.slewA0 = 1 / (1 + k);
    this.slewB1 = (1 - k) / (1 + k);
    this.Rdist = 55e3;
    this.Rfilt = 1.5e3;
    this.vc3 = 0;
    this.i1Prev = 0;
    this.slewX1 = 0;
    this.slewY1 = 0;
    this.vc6 = 0;
    this.iFiltPrev = 0;
    this.vdPrev = 0;
    /** 求解器统计(评测用,不影响数值) */
    this.iterTotal = 0;
    this.iterCount = 0;
  }

  /** drive 0~1 → Rdist = 0~100k(HF 增益 1 + Rdist/R3 ≈ 1 ~ 2130) */
  setDrive(d) {
    this.Rdist = 100e3 * Math.min(1, Math.max(0, d));
  }

  /** filter 0~100(旋钮反向)→ 支路总电阻 R6+Rpot = 1/(2π·fc·C6) */
  setFilter(v) {
    this.Rfilt = 1 / (2 * Math.PI * filterToFreq(v) * this.C6);
  }

  process(vin) {
    const a3 = this.T / (2 * this.C3);
    const i1 = (vin - this.vc3 - a3 * this.i1Prev) / (this.R3 + a3);
    this.vc3 += a3 * (i1 + this.i1Prev);
    this.i1Prev = i1;
    const vg = vin + this.Rdist * i1;

    const v2 = this.slewA0 * (vg + this.slewX1) - this.slewB1 * this.slewY1;
    this.slewX1 = vg;
    this.slewY1 = v2;

    const { Is, nVt } = DIODE_1N914;
    const gf = 1 / (this.Rfilt + this.a6);
    const gSum = this.G5 + gf;
    const known6 = (this.vc6 + this.a6 * this.iFiltPrev) * gf;
    const c5 = v2 * this.G5;
    let vd = this.vdPrev;
    let iter = 0;
    for (; iter < 12; iter++) {
      const f = vd * gSum - c5 - known6 + 2 * Is * Math.sinh(vd / nVt);
      if (Math.abs(f) < 1e-12) break;
      const df = gSum + ((2 * Is) / nVt) * Math.cosh(vd / nVt);
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
    const iF = gf * vd - known6;
    this.vc6 += this.a6 * (iF + this.iFiltPrev);
    this.iFiltPrev = iF;
    return this.vc6;
  }
}

/**
 * RAT 全链路引擎。process(inputs, outputs, params) 语义与
 * AudioWorkletProcessor.process 一致;采样率由构造注入(替代 worklet 全局
 * sampleRate),引擎内不含任何 AudioWorklet API。
 */
export class WdfRatEngine {
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
      rat: new RatStage(fs),
      up: new Upsampler4x(this.fir),
      down: new Decimator4x(this.fir),
      lastDrive: -1,
      lastFilter: -1,
    };
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    while (this.chains.length < input.length) this.chains.push(this.createChain());

    const level = params.level[0];
    const drive = params.drive[0] / 100;
    const filter = params.filter[0];
    const osIn = new Float32Array(OS_FACTOR);

    for (let ch = 0; ch < input.length; ch++) {
      const c = this.chains[ch];
      if (c.lastDrive !== drive) {
        c.rat.setDrive(drive);
        c.lastDrive = drive;
      }
      if (c.lastFilter !== filter) {
        c.rat.setFilter(filter);
        c.lastFilter = filter;
      }
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) {
        c.up.process(osIn, inp[i]);
        const y0 = c.rat.process(osIn[0]);
        const y1 = c.rat.process(osIn[1]);
        const y2 = c.rat.process(osIn[2]);
        const y3 = c.rat.process(osIn[3]);
        out[i] = c.down.process(y0, y1, y2, y3) * level;
      }
    }
    return true;
  }
}
