/**
 * WDF 版 TS808 削波单块 DSP 核——单一来源(ADR-0003)。
 *
 * 链路:
 *   输入 → WDF 削波级(运放 + 反并联 1N4148 对,720Hz 反馈高通,DRIVE)
 *   → 音色级:723Hz 固定无源低通 + TONE 高架(3.2kHz,主动电路近似,-12~+3dB)
 *   → LEVEL(线性,dB 域由外层转换)→ 输出
 *   内部 4x 过采样(resample.dsp.js)。每通道独立链路状态。
 *
 * 削波级求解(每样本):
 *   1) Z1 支路电流 i1(串联 R4-C3,线性,梯形精确解,与 Vd 无关)
 *   2) Newton 解 Vd:F(Vd) = Id(Vd) + Vd/Rf + iC4(Vd) - i1 = 0
 *      反并联二极管对 Id(Vd) = 2·Is·sinh(Vd/(n·Vt)),解析 Jacobian
 *   3) Vout = Vin + Vd
 *
 * 双模式消费:worklet(ts808Worklet.ts)经 `?raw` 取源码字符串拼装 Blob;
 * eval/测试直接 import。只用单行 import 与内联 export(buildProcessorSource
 * 依赖此约定剥离模块语法)。以原 worklet 内联版(用户实际听到的代码)为权威
 * 逐表达式平移;已删除的 diodeClipper.ts 的 options 注入未保留(eval 脚本
 * 未使用),求解器统计(iterTotal/iterCount)以附加字段保留,不影响数值。
 */
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from './resample.dsp.js';

/** 1N4148 二极管参数(WDF 文献标准值:chowdsp / Yeh 论文) */
export const DIODE_1N4148 = { Is: 2.52e-9, nVt: 1.752 * 25.85e-3 };

export class TsClipperStage {
  /** @param {number} fs 采样率(含过采样倍率后的实际速率) */
  constructor(fs) {
    this.T = 1 / fs;
    this.R4 = 4.7e3;
    this.C3 = 0.047e-6;
    this.G4 = (2 * 51e-12) / this.T;
    this.Rf = 51e3 + 250e3;
    this.vc3 = 0;
    this.i1Prev = 0;
    this.ih4 = 0;
    this.vdPrev = 0;
    /** 求解器统计(评测用,不影响数值) */
    this.iterTotal = 0;
    this.iterCount = 0;
  }

  /** drive 0~1 → Rf = 51k + 500k·drive(TS 增益 1+Zf/Z1 ≈ 12~118) */
  setDrive(d) {
    this.Rf = 51e3 + 500e3 * Math.min(1, Math.max(0, d));
  }

  process(vin) {
    const a = this.T / (2 * this.C3);
    const i1 = (vin - this.vc3 - a * this.i1Prev) / (this.R4 + a);
    this.vc3 += a * (i1 + this.i1Prev);
    this.i1Prev = i1;

    const { Is, nVt } = DIODE_1N4148;
    const gSum = 1 / this.Rf + this.G4;
    let vd = this.vdPrev;
    let iter = 0;
    for (; iter < 12; iter++) {
      const f = 2 * Is * Math.sinh(vd / nVt) + vd * gSum + this.ih4 - i1;
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
    const iC4 = this.G4 * vd + this.ih4;
    this.ih4 = -this.G4 * vd - iC4;
    return vin + vd;
  }
}

/**
 * TS808 全链路引擎。process(inputs, outputs, params) 语义与
 * AudioWorkletProcessor.process 一致;采样率由构造注入(替代 worklet 全局
 * sampleRate),引擎内不含任何 AudioWorklet API。
 */
export class WdfTs808Engine {
  /** @param {number} sampleRate 基率采样率(引擎内部自行 ×OS_FACTOR) */
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.fir = makeAntiAliasFIR();
    /** @type {object[]} 每通道独立链路状态 */
    this.chains = [];
  }

  createChain() {
    const fs = this.sampleRate * OS_FACTOR;
    const c = new TsClipperStage(fs);
    return {
      clipper: c,
      up: new Upsampler4x(this.fir),
      down: new Decimator4x(this.fir),
      lpY1: 0,     // 723Hz 无源低通
      toneLpY1: 0, // TONE 高架的低通分量
      lastDrive: -1,
    };
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    while (this.chains.length < input.length) this.chains.push(this.createChain());

    const T = 1 / (this.sampleRate * OS_FACTOR);
    const aLp = T / (1 / (2 * Math.PI * 723) + T);
    const aTone = T / (1 / (2 * Math.PI * 3200) + T);
    // tone 0~100 → 高架 dB(-12 ~ +3),同现行 ts808
    const toneDb = ((params.tone[0] - 50) / 50) * 15;
    const toneG = Math.pow(10, toneDb / 20);
    const level = params.level[0];
    const drive = params.drive[0] / 100;
    const osIn = new Float32Array(OS_FACTOR);
    const osOut = new Float32Array(OS_FACTOR);

    for (let ch = 0; ch < input.length; ch++) {
      const c = this.chains[ch];
      if (c.lastDrive !== drive) {
        c.clipper.setDrive(drive);
        c.lastDrive = drive;
      }
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) {
        c.up.process(osIn, inp[i]);
        for (let k = 0; k < OS_FACTOR; k++) {
          const s = c.clipper.process(osIn[k]);
          // 723Hz 无源低通
          c.lpY1 += aLp * (s - c.lpY1);
          // TONE 高架(一阶):low + g·(x - low)
          c.toneLpY1 += aTone * (c.lpY1 - c.toneLpY1);
          osOut[k] = c.toneLpY1 + toneG * (c.lpY1 - c.toneLpY1);
        }
        out[i] = c.down.process(osOut[0], osOut[1], osOut[2], osOut[3]) * level;
      }
    }
    return true;
  }
}
