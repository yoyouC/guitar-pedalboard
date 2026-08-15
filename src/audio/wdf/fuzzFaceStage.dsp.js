/**
 * WDF 版 Fuzz Face 两级锗管放大级 DSP 核——单一来源(ADR-0003)。
 *
 * 链路:
 *   输入 → FuzzFace 两级锗管放大级(简化 Ebers-Moll 双 BJT,3 变量隐式 Newton,
 *          100k 电压反馈偏置,FUZZ = Q2 发射极 1k 电位器)
 *   → LEVEL(线性,dB 域由外层转换)→ 输出
 *   内部 4x 过采样(resample.dsp.js)。每通道独立链路状态。
 *
 * 双模式消费:worklet(fuzzfaceWorklet.ts)经 `?raw` 取本文件源码字符串,
 * 与 wrapper 拼装进 Blob;eval/测试直接 import。只用单行 import 与内联 export
 * (buildProcessorSource 依赖此约定剥离模块语法)。
 * 本文件以 worklet 内联版为权威逐表达式平移(issue #7;音色零变化)。
 * 审计例外(待维护者裁定):已删除的 core 版 setFuzz 在 Vcc 变化时**不**重解 DC
 * (注释称让偏置像真实电源跌落一样自然迁移);内联版重解——本文件以内联版为准。
 */
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from './resample.dsp.js';

/** 3x3 线性方程组(部分主元高斯消元);奇异时返回 null */
function solve3(a11,a12,a13,a21,a22,a23,a31,a32,a33,b1,b2,b3) {
  const p = Math.abs(a11) > Math.abs(a21) ? (Math.abs(a11) > Math.abs(a31) ? 0 : 2) : (Math.abs(a21) > Math.abs(a31) ? 1 : 2);
  let r1 = [a11,a12,a13,b1], r2 = [a21,a22,a23,b2], r3 = [a31,a32,a33,b3], t, f;
  if (p === 1) { t = r1; r1 = r2; r2 = t; }
  else if (p === 2) { t = r1; r1 = r3; r3 = t; }
  if (Math.abs(r1[0]) < 1e-30) return null;
  f = r2[0] / r1[0];
  for (let c = 0; c < 4; c++) r2[c] -= f * r1[c];
  f = r3[0] / r1[0];
  for (let c = 0; c < 4; c++) r3[c] -= f * r1[c];
  if (Math.abs(r3[1]) > Math.abs(r2[1])) { t = r2; r2 = r3; r3 = t; }
  if (Math.abs(r2[1]) < 1e-30) return null;
  f = r3[1] / r2[1];
  for (let c = 1; c < 4; c++) r3[c] -= f * r2[c];
  if (Math.abs(r3[2]) < 1e-30) return null;
  const x3 = r3[3] / r3[2];
  const x2 = (r2[3] - r2[2] * x3) / r2[1];
  const x1 = (r1[3] - r1[2] * x3 - r1[1] * x2) / r1[0];
  return [x1, x2, x3];
}

const MAX_ITER = 80;
const TOL = 1e-8;
const STEP_MAX = 0.05;
const EXP_MAX = 40;

/**
 * Fuzz Face 两级锗管放大级(伴随模型/梯形积分,与双线性 WDF 等效)。
 * 每样本 3 变量隐式 Newton(vb1, vc1, ve2) + 内层 vc2 safeguarded 1D 求解;
 * 构造时 solveDC 并一致初始化全部电容状态。
 */
export class FuzzFaceStage {
  /**
   * @param {number} fs 采样率(含过采样倍率后的实际速率)
   * @param {{ Rs?: number }} [opts] 可选注入(评测用);默认值与内联硬编码一致
   */
  constructor(fs, opts = {}) {
    this.T = 1 / fs;
    this.Vcc = 9;
    this.Rs = opts.Rs ?? 10e3;
    this.Is = 1e-7;
    this.BF = 80;
    this.BR = 1;
    this.Vt = 26e-3;
    this.Rc1 = 33e3;
    this.Rc2a = 8.2e3;
    this.Rc2b = 470;
    this.Rfb = 100e3;
    this.Rload = 500e3;
    this.GcIn = 2 * 2.2e-6 / this.T;
    this.GcK = 2 * 20e-6 / this.T;
    this.GcO = 2 * 0.01e-6 / this.T;
    this.dO = 1 + this.GcO * this.Rload;
    this.Rtop = 500;
    this.Rbot = 500;
    this.vCinPrev = 0; this.iCinPrev = 0;
    this.vwPrev = 0; this.iCkPrev = 0;
    this.vCoutPrev = 0; this.iCoutPrev = 0;
    this.vb1 = 0.2; this.vc1 = 0.72; this.ve2 = 0.5; this.vc2 = 4.7;
    this.vinPrev = 0;
    this.iterTotal = 0; this.iterCount = 0;
    this.nonConverged = 0;
    this.voutPrev = 0;
    this.solveDC();
  }

  setFuzz(fuzz) {
    const f = Math.min(1, Math.max(0, fuzz));
    this.Rtop = (1 - f) * 1000;
    this.Rbot = f * 1000;
    // 顶端 30% 行程联动电源亏电(dying-battery 质感)
    const starve = Math.max(0, (f - 0.7) / 0.3);
    const newVcc = 9 - starve * 5.0;
    if (newVcc !== this.Vcc) {
      this.Vcc = newVcc;
      this.solveDC();
    }
  }

  expArg(v) {
    const x = v / this.Vt;
    return x > EXP_MAX ? Math.exp(EXP_MAX) : x < -EXP_MAX ? 0 : Math.exp(x);
  }

  newtonSolve(ctx, start) {
    const Is = this.Is, BF = this.BF, BR = this.BR, Vt = this.Vt;
    const iBR = 1 + 1 / BR;
    let vb1 = start.vb1, vc1 = start.vc1, ve2 = start.ve2, vc2 = start.vc2;

    const evalRes = (a, b, c, vc2g) => {
      const eBe1 = this.expArg(a);
      const eBc1 = this.expArg(a - b);
      const if1 = Is * (eBe1 - 1);
      const ir1 = Is * (eBc1 - 1);
      const ic1 = if1 - ir1 * iBR;
      const ib1 = if1 / BF + ir1 / BR;
      // Q1 B-E 反向击穿软化(音频区永不触发)
      const xBr = -(a + 4) / 0.1;
      const eBr = xBr > EXP_MAX ? Math.exp(EXP_MAX) : xBr < -EXP_MAX ? 0 : Math.exp(xBr);
      const ibd = -1e-6 * eBr;

      const vbe2 = b - c;
      const eBe2 = this.expArg(vbe2);
      let lo = -2, hi = 12;
      let v2 = vc2g < lo ? lo + 1e-6 : vc2g > hi ? hi - 1e-6 : vc2g;
      let eBc2 = 0;
      for (let k = 0; k < 40; k++) {
        eBc2 = this.expArg(b - v2);
        const ic2k = Is * (eBe2 - 1) - Is * (eBc2 - 1) * iBR;
        const g = v2 - ctx.A - ctx.B * ic2k;
        if (Math.abs(g) < 1e-9 || hi - lo < 1e-9) break;
        if (g > 0) hi = v2; else lo = v2;
        const dg = 1 - ctx.B * ((Is / Vt) * eBc2 * iBR);
        let vNew = v2 - g / dg;
        if (!Number.isFinite(vNew) || vNew <= lo || vNew >= hi) vNew = (lo + hi) / 2;
        v2 = vNew;
      }
      eBc2 = this.expArg(b - v2);
      const if2 = Is * (eBe2 - 1);
      const ir2 = Is * (eBc2 - 1);
      const ib2 = if2 / BF + ir2 / BR;
      const ie2 = if2 * (1 + 1 / BF) + ir2;

      const r1 = ctx.iCinAt(a) - ib1 - ibd - (a - c) / this.Rfb;
      const r2 = (this.Vcc - b) / this.Rc1 - ic1 - ib2;
      const r3 = ie2 - (c - ctx.vhE2) / ctx.reqE2 - (c - a) / this.Rfb;
      return { r1, r2, r3, eBe1, eBc1, eBe2, eBc2, eBr, vc2: v2 };
    };

    let cur = evalRes(vb1, vc1, ve2, vc2);
    vc2 = cur.vc2;
    let rMax = Math.max(Math.abs(cur.r1), Math.abs(cur.r2), Math.abs(cur.r3));

    let iter = 0;
    for (; iter < ctx.maxIter && rMax >= TOL; iter++) {
      const gBe1 = (Is / Vt) * cur.eBe1, gBc1 = (Is / Vt) * cur.eBc1;
      const gBe2 = (Is / Vt) * cur.eBe2, gBc2 = (Is / Vt) * cur.eBc2;
      const gB2 = gBc2 * iBR;
      const dDenom = 1 - ctx.B * gB2;
      const p1 = ctx.B * (gBe2 - gB2) / dDenom;
      const p3 = -ctx.B * gBe2 / dDenom;
      const j11 = ctx.gIn - (gBe1 / BF + gBc1 / BR) - (1e-6 / 0.1) * cur.eBr - 1 / this.Rfb;
      const j12 = gBc1 / BR;
      const j13 = 1 / this.Rfb;
      const j21 = -(gBe1 - gBc1 * iBR);
      const j22 = -1 / this.Rc1 - gBc1 * iBR - (gBe2 / BF + (gBc2 / BR) * (1 - p1));
      const j23 = gBe2 / BF + (gBc2 / BR) * p3;
      const j31 = 1 / this.Rfb;
      const j32 = gBe2 * (1 + 1 / BF) + gBc2 * (1 - p1);
      const j33 = -gBe2 * (1 + 1 / BF) - gBc2 * p3 - 1 / ctx.reqE2 - 1 / this.Rfb;

      const dx = solve3(j11,j12,j13,j21,j22,j23,j31,j32,j33,-cur.r1,-cur.r2,-cur.r3);
      if (!dx) break;

      const full = Math.abs(dx[0]) <= STEP_MAX && Math.abs(dx[1]) <= STEP_MAX && Math.abs(dx[2]) <= STEP_MAX;
      const damp = full ? 1 : 0.5;
      let d1 = dx[0] * damp, d2 = dx[1] * damp, d3 = dx[2] * damp;
      if (d1 > STEP_MAX) d1 = STEP_MAX; else if (d1 < -STEP_MAX) d1 = -STEP_MAX;
      if (d2 > STEP_MAX) d2 = STEP_MAX; else if (d2 < -STEP_MAX) d2 = -STEP_MAX;
      if (d3 > STEP_MAX) d3 = STEP_MAX; else if (d3 < -STEP_MAX) d3 = -STEP_MAX;
      vb1 += d1; vc1 += d2; ve2 += d3;
      if (vb1 > 12) vb1 = 12; else if (vb1 < -12) vb1 = -12;
      if (vc1 > 12) vc1 = 12; else if (vc1 < -12) vc1 = -12;
      if (ve2 > 12) ve2 = 12; else if (ve2 < -12) ve2 = -12;
      cur = evalRes(vb1, vc1, ve2, vc2);
      vc2 = cur.vc2;
      rMax = Math.max(Math.abs(cur.r1), Math.abs(cur.r2), Math.abs(cur.r3));
    }
    return { vb1, vc1, ve2, vc2, rMax, iters: iter };
  }

  solveDC() {
    const s = this.newtonSolve(
      { iCinAt: () => 0, gIn: 0, reqE2: 1000, vhE2: 0,
        A: this.Vcc, B: -(this.Rc2a + this.Rc2b), maxIter: 50 },
      this,
    );
    this.vb1 = s.vb1; this.vc1 = s.vc1; this.ve2 = s.ve2; this.vc2 = s.vc2;
    const Is = this.Is, BR = this.BR;
    const iBR = 1 + 1 / BR;
    const eBe2 = this.expArg(s.vc1 - s.ve2);
    const eBc2 = this.expArg(s.vc1 - s.vc2);
    const ic2 = Is * (eBe2 - 1) - Is * (eBc2 - 1) * iBR;
    const vx = this.Vcc - ic2 * this.Rc2a;
    this.vCinPrev = -s.vb1;
    this.iCinPrev = 0;
    this.vwPrev = s.ve2 * (this.Rbot / 1000);
    this.iCkPrev = 0;
    this.vCoutPrev = vx;
    this.iCoutPrev = 0;
    this.voutPrev = 0;
  }

  process(vin) {
    const ihIn = -this.GcIn * this.vCinPrev - this.iCinPrev;
    const ihK = -this.GcK * this.vwPrev - this.iCkPrev;
    const ihO = -this.GcO * this.vCoutPrev - this.iCoutPrev;

    const reqS = this.Rbot > 1e-9 ? 1 / (this.GcK + 1 / this.Rbot) : 0;
    const reqE2 = this.Rtop + reqS;
    const vhE2 = -ihK * reqS;

    const kA = this.Vcc / this.Rc2a - ihO / this.dO;
    const kB = 1 / this.Rc2a + this.GcO / this.dO;
    const A = kA / kB;
    const B = -(1 / kB + this.Rc2b);

    const inDenom = 1 + this.Rs * this.GcIn;
    const gInEff = this.GcIn / inDenom;

    let s = null;
    let totalIters = 0;
    let vinUsed = vin;
    const ladder = [[1, 0], [2, 0], [4, 0], [8, 0], [16, 0], [16, 1.0], [16, 0.5]];
    for (let li = 0; li < ladder.length; li++) {
      const kMax = ladder[li][0], slew = ladder[li][1];
      vinUsed = slew > 0
        ? this.vinPrev + Math.min(slew, Math.max(-slew, vin - this.vinPrev))
        : vin;
      let u = { vb1: this.vb1, vc1: this.vc1, ve2: this.ve2, vc2: this.vc2 };
      let failed = false;
      totalIters = 0;
      for (let j = 1; j <= kMax; j++) {
        const vj = this.vinPrev + (vinUsed - this.vinPrev) * (j / kMax);
        const r = this.newtonSolve(
          { iCinAt: (a) => gInEff * (vj - a) + ihIn / inDenom,
            gIn: -gInEff, reqE2, vhE2, A, B, maxIter: MAX_ITER },
          u,
        );
        totalIters += r.iters;
        if (r.rMax >= TOL) { failed = true; break; }
        u = r;
      }
      if (!failed) { s = u; break; }
    }
    this.iterTotal += totalIters;
    this.iterCount++;

    if (!s) {
      this.nonConverged++;
      this.vinPrev += Math.min(0.5, Math.max(-0.5, vin - this.vinPrev));
      return this.voutPrev;
    }
    this.vinPrev = vinUsed;
    const vb1 = s.vb1, vc1 = s.vc1, ve2 = s.ve2;
    this.vb1 = s.vb1; this.vc1 = s.vc1; this.ve2 = s.ve2; this.vc2 = s.vc2;

    const iCin = gInEff * (vinUsed - vb1) + ihIn / inDenom;
    this.vCinPrev = vinUsed - iCin * this.Rs - vb1;
    this.iCinPrev = iCin;

    const iEPort = (ve2 - vhE2) / reqE2;
    const vw = ve2 - iEPort * this.Rtop;
    if (this.Rbot > 1e-9) {
      const iCk = this.GcK * vw + ihK;
      this.vwPrev = vw;
      this.iCkPrev = iCk;
    } else {
      this.vwPrev = 0;
      this.iCkPrev = 0;
    }

    const Is = this.Is, BR = this.BR;
    const iBR = 1 + 1 / BR;
    const eBe2 = this.expArg(vc1 - ve2);
    const eBc2 = this.expArg(vc1 - this.vc2);
    const ic2 = Is * (eBe2 - 1) - Is * (eBc2 - 1) * iBR;
    const vx = (kA - ic2) / kB;
    const iCout = (this.GcO * vx + ihO) / this.dO;
    const vout = this.Rload * iCout;
    this.vCoutPrev = vx - vout;
    this.iCoutPrev = iCout;

    this.voutPrev = vout;
    return vout;
  }
}

/**
 * Fuzz Face 全链路引擎。process(inputs, outputs, params) 语义与
 * AudioWorkletProcessor.process 一致;采样率由构造注入(替代 worklet 全局
 * sampleRate),引擎内不含任何 AudioWorklet API。
 */
export class WdfFuzzFaceEngine {
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
      stage: new FuzzFaceStage(fs),
      up: new Upsampler4x(this.fir),
      down: new Decimator4x(this.fir),
      lastFuzz: -1,
    };
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    while (this.chains.length < input.length) this.chains.push(this.createChain());

    const level = params.level[0];
    const fuzz = params.fuzz[0] / 100;
    const osIn = new Float32Array(OS_FACTOR);
    const osOut = new Float32Array(OS_FACTOR);

    for (let ch = 0; ch < input.length; ch++) {
      const c = this.chains[ch];
      if (c.lastFuzz !== fuzz) {
        c.stage.setFuzz(fuzz);
        c.lastFuzz = fuzz;
      }
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) {
        c.up.process(osIn, inp[i]);
        for (let k = 0; k < OS_FACTOR; k++) osOut[k] = c.stage.process(osIn[k]);
        out[i] = c.down.process(osOut[0], osOut[1], osOut[2], osOut[3]) * level;
      }
    }
    return true;
  }
}
