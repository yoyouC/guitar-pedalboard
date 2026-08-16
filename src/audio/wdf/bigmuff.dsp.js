/**
 * WDF 版 Electro-Harmonix Big Muff Pi(V3,1976-77)DSP 核——单一来源(ADR-0003)。
 *
 * 链路(ElectroSmash Big Muff Pi Analysis,V3 元件值):
 *   输入缓冲(略)→ SUSTAIN 分压(100k 线性电位器,R23 防截止略)
 *   → C3 100nF 耦合 HP(~90Hz)→ BJT 削波级 1(Q2 2N5088,Rc=10k/Re=150/Rf=470k)
 *     集电极反并联 1N4148 对地削波(D1/D2)
 *   → C13 100nF 级间 HP(~155Hz)→ 级2 输入 Miller 等效 LP(~920Hz)
 *   → BJT 削波级 2(Q3 同构,D3/D4 对地)
 *   → C7 1uF 输出耦合 HP(~3.2Hz)→ Rsrc=10k(级2 集电极输出阻抗)
 *   → TONE 无源交叉淡化:LP 臂 R8=39k→C8=10nF→地;HP 臂 C9=4nF→R5=22k→地;
 *     100k 电位器在两臂节点间,滑点输出 =(1-t)·vA + t·vB(中位 ~1kHz 中频大凹陷)
 *   → 输出缓冲(略,单位增益)→ LEVEL(线性,dB 域由外层转换)→ 输出
 *   内部 4x 过采样(resample.dsp.js)。每通道独立链路状态。
 *
 * BJT 级理想化为"反相增益块 + 戴维南输出电阻 + 二极管对"——与 TS808 的
 * "理想运放"路线一致:二极管钳位在 ±0.6V,BJT 始终在线性区,器件物理由
 * ngspice 全 BJT 小信号扫频校准注入(2N5088,Rc=10k/Re=150/Rf=470k,Cm=470p):
 *   A1=16(反相),Rth1=6.9k(Rc1||Rf1||级2输入阻抗)
 *   A2=42(反相),Rth2=9.8k(Rc2||Rf2;音调网络负载效应略)
 *   级间 LP 920Hz ≈ 级2 输入 Miller 电容对级1集电极的加载极点(冻结线性化,
 *   重削波时真实电路增益塌陷、带宽回升,本模型不还原——妥协)。
 *
 * 已知妥协(v1):
 * - 音调网络对级2钳位节点的负载不进 Newton(缓冲近似):钳位下二极管阻抗
 *   ~几百 Ω 远小于音调输入阻抗,误差 <2%;小信号下等效为级2增益略偏高。
 * - SUSTAIN 电位器滑变时的源阻抗变化(10k~25k)忽略,分压取理想线性。
 * - BJT 自身饱和/截止硬削波不建模(二极管先钳位,物理上成立)。
 *
 * 求解:每级每样本 1D Newton,F(vc)=2·Is·sinh(vc/nVt)+(vc-vth)/Rth=0,
 * 解析 Jacobian、步长阻尼、初值沿用上一样本。
 *
 * 双模式消费:worklet(bigmuffWorklet.ts)经 `?raw` 取源码字符串拼装 Blob;
 * eval/测试直接 import。只用单行 import 与内联 export(buildProcessorSource
 * 依赖此约定剥离模块语法)。以原 worklet 内联版(用户实际听到的代码)为权威
 * 逐表达式平移;BigMuffChain 从已删除的 bigmuff.ts 平移(eval API,内联版
 * 把同一链摊在 process 里,数值路径一致);MuffTone.inv 用普通 Array(内联版
 * 形态,core 的 Float64Array 数值等价);求解器统计(iterTotal/iterCount)
 * 以附加字段保留,不影响数值。
 */
import { DIODE_1N4148 } from './diodeClipper.dsp.js';
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from './resample.dsp.js';

/** 模型常数(校准来源见头注释) */
export const MUFF = {
  A1: 16, // 级1 反相增益(src→c1 中频带)
  RTH1: 6.9e3, // 级1 集电极戴维南电阻
  A2: 42, // 级2 反相增益(c1→c2 中频带)
  RTH2: 9.8e3, // 级2 集电极戴维南电阻
  FC_HP_IN: 90, // C3 100nF 输入耦合
  FC_HP_MID: 155, // C13 100nF 级间耦合
  FC_LP_MID: 920, // 级2 Miller 输入电容对级1集电极的加载极点
  FC_HP_OUT: 3.2, // C7 1uF 输出耦合
  // TONE 网络(V3 原值)
  TONE_RSRC: 10e3, // 级2 集电极输出阻抗
  TONE_R_LP: 39e3, // R8:LP 臂串联电阻
  TONE_C_LP: 10e-9, // C8:LP 臂对地电容 → fc≈325Hz(含 Rsrc)
  TONE_C_HP: 4e-9, // C9:HP 臂串联电容
  TONE_R_HP: 22e3, // R5:HP 臂对地电阻 → fc≈1.81kHz
  TONE_POT: 100e3, // TONE 电位器(线性)
};

/** 一阶高通(双线性):y[n]=a1·y[n-1]+b0·(x[n]-x[n-1]) */
export class OnePoleHP {
  constructor(fs, fc) {
    const K = 2 * fs;
    const w = 2 * Math.PI * fc;
    this.b0 = K / (K + w);
    this.a1 = (K - w) / (K + w);
    this.x1 = 0;
    this.y1 = 0;
  }
  process(x) {
    const y = this.a1 * this.y1 + this.b0 * (x - this.x1);
    this.x1 = x;
    this.y1 = y;
    return y;
  }
}

/** 一阶低通(双线性):y[n]=a1·y[n-1]+b0·(x[n]+x[n-1]) */
export class OnePoleLP {
  constructor(fs, fc) {
    const K = 2 * fs;
    const w = 2 * Math.PI * fc;
    this.b0 = w / (K + w);
    this.a1 = (K - w) / (K + w);
    this.x1 = 0;
    this.y1 = 0;
  }
  process(x) {
    const y = this.a1 * this.y1 + this.b0 * (x + this.x1);
    this.x1 = x;
    this.y1 = y;
    return y;
  }
}

/**
 * 单削波级:理想反相增益 A + 戴维南电阻 Rth + 反并联二极管对到地。
 * Newton:F(vc)=2·Is·sinh(vc/nVt)+(vc-vth)/Rth=0,vth=-A·vs。
 */
export class MuffClipStage {
  constructor(A, Rth) {
    this.A = A;
    this.gTh = 1 / Rth;
    this.vcPrev = 0;
    /** 求解器统计(评测用,不影响数值) */
    this.iterTotal = 0;
    this.iterCount = 0;
  }
  process(vs) {
    const vth = -this.A * vs;
    const { Is, nVt } = DIODE_1N4148;
    let vc = this.vcPrev;
    let iter = 0;
    for (; iter < 12; iter++) {
      const f = 2 * Is * Math.sinh(vc / nVt) + (vc - vth) * this.gTh;
      if (Math.abs(f) < 1e-12) break;
      const df = ((2 * Is) / nVt) * Math.cosh(vc / nVt) + this.gTh;
      let step = f / df;
      if (step > 0.2) step = 0.2;
      else if (step < -0.2) step = -0.2;
      vc -= step;
      if (vc > 1.0) vc = 1.0;
      else if (vc < -1.0) vc = -1.0;
    }
    this.iterTotal += iter;
    this.iterCount++;
    this.vcPrev = vc;
    return vc;
  }
}

/**
 * TONE 无源交叉淡化(精确离散化,梯形伴随 + 3×3 线性求解)。
 *
 *   vh ──Rsrc──● s
 *              ├─R8─┬─● A(LP 节点)── C8 ── 地
 *              │    └─P(100k)─┐
 *              └─C9─┬─● B(HP 节点)── R5 ── 地
 *                   └─────────┘
 *   out = (1-t)·vA + t·vB(滑点开路 → A/B 间恒为 P,矩阵与 t 无关)
 */
export class MuffTone {
  constructor(fs) {
    const T = 1 / fs;
    const M = MUFF;
    this.gC8 = (2 * M.TONE_C_LP) / T;
    this.gC9 = (2 * M.TONE_C_HP) / T;
    this.ih8 = 0;
    this.ih9 = 0;
    this.t = 0.5;
    const gSrc = 1 / M.TONE_RSRC;
    const gR8 = 1 / M.TONE_R_LP;
    const gR5 = 1 / M.TONE_R_HP;
    const gP = 1 / M.TONE_POT;
    const a = gSrc + gR8 + this.gC9, b = -gR8, c = -this.gC9;
    const d = -gR8, e = gR8 + this.gC8 + gP, f = -gP;
    const g = -this.gC9, h = -gP, i = this.gC9 + gR5 + gP;
    const Ai = e * i - f * h;
    const Bi = c * h - b * i;
    const Ci = b * f - c * e;
    const det = a * Ai + d * Bi + g * Ci;
    this.inv = [
      Ai / det, Bi / det, Ci / det,
      (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
      (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
    ];
  }
  /** tone 0~1:0=全 LP(暗),1=全 HP(亮) */
  setTone(t) {
    this.t = Math.min(1, Math.max(0, t));
  }
  process(vh) {
    const inv = this.inv;
    const r0 = vh / MUFF.TONE_RSRC - this.ih9;
    const r1 = -this.ih8;
    const r2 = this.ih9;
    const vs = inv[0] * r0 + inv[1] * r1 + inv[2] * r2;
    const vA = inv[3] * r0 + inv[4] * r1 + inv[5] * r2;
    const vB = inv[6] * r0 + inv[7] * r1 + inv[8] * r2;
    const i8 = this.gC8 * vA + this.ih8;
    this.ih8 = -this.gC8 * vA - i8;
    const dv9 = vs - vB;
    const i9 = this.gC9 * dv9 + this.ih9;
    this.ih9 = -this.gC9 * dv9 - i9;
    return (1 - this.t) * vA + this.t * vB;
  }
}

/**
 * 完整 Big Muff 链(过采样速率下运行;升/降采样在外层,eval 用——
 * worklet 引擎把同一链摊在 process 里,数值路径一致)。
 */
export class BigMuffChain {
  /** @param {number} fs 过采样域采样率 */
  constructor(fs) {
    this.hpIn = new OnePoleHP(fs, MUFF.FC_HP_IN);
    this.stage1 = new MuffClipStage(MUFF.A1, MUFF.RTH1);
    this.hpMid = new OnePoleHP(fs, MUFF.FC_HP_MID);
    this.lpMid = new OnePoleLP(fs, MUFF.FC_LP_MID);
    this.stage2 = new MuffClipStage(MUFF.A2, MUFF.RTH2);
    this.hpOut = new OnePoleHP(fs, MUFF.FC_HP_OUT);
    this.tone = new MuffTone(fs);
    this.sustain = 0.5;
  }

  /** sustain 0~1:SUSTAIN 电位器分压(第一级驱动) */
  setSustain(k) {
    this.sustain = Math.min(1, Math.max(0, k));
  }

  /** tone 0~1 */
  setTone(t) {
    this.tone.setTone(t);
  }

  process(x) {
    return this.processWithTaps(x).out;
  }

  /** 与 process 相同,另返回两级削波节点(评测用) */
  processWithTaps(x) {
    const u1 = this.hpIn.process(this.sustain * x);
    const c1 = this.stage1.process(u1);
    const u2 = this.lpMid.process(this.hpMid.process(c1));
    const c2 = this.stage2.process(u2);
    return { out: this.tone.process(this.hpOut.process(c2)), c1, c2 };
  }
}

/**
 * Big Muff 全链路引擎。process(inputs, outputs, params) 语义与
 * AudioWorkletProcessor.process 一致;采样率由构造注入(替代 worklet 全局
 * sampleRate),引擎内不含任何 AudioWorklet API。
 */
export class WdfBigMuffEngine {
  /** @param {number} sampleRate 基率采样率(引擎内部自行 ×OS_FACTOR) */
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.fir = makeAntiAliasFIR();
    /** @type {object[]} 每通道独立链路状态 */
    this.chains = [];
  }

  createChain() {
    const fs = this.sampleRate * OS_FACTOR;
    const M = MUFF;
    return {
      up: new Upsampler4x(this.fir),
      down: new Decimator4x(this.fir),
      hpIn: new OnePoleHP(fs, M.FC_HP_IN),
      stage1: new MuffClipStage(M.A1, M.RTH1),
      hpMid: new OnePoleHP(fs, M.FC_HP_MID),
      lpMid: new OnePoleLP(fs, M.FC_LP_MID),
      stage2: new MuffClipStage(M.A2, M.RTH2),
      hpOut: new OnePoleHP(fs, M.FC_HP_OUT),
      tone: new MuffTone(fs),
    };
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    while (this.chains.length < input.length) this.chains.push(this.createChain());

    const sustain = params.sustain[0] / 100;
    const toneT = params.tone[0] / 100;
    const level = params.level[0];
    const osIn = new Float32Array(OS_FACTOR);
    const osOut = [0, 0, 0, 0];

    for (let ch = 0; ch < input.length; ch++) {
      const c = this.chains[ch];
      c.tone.setTone(toneT);
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) {
        c.up.process(osIn, inp[i]);
        for (let k = 0; k < OS_FACTOR; k++) {
          const u1 = c.hpIn.process(sustain * osIn[k]);
          const c1 = c.stage1.process(u1);
          const u2 = c.lpMid.process(c.hpMid.process(c1));
          const c2 = c.stage2.process(u2);
          osOut[k] = c.tone.process(c.hpOut.process(c2));
        }
        out[i] = c.down.process(osOut[0], osOut[1], osOut[2], osOut[3]) * level;
      }
    }
    return true;
  }
}
