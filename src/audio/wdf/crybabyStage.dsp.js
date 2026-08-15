/**
 * WDF 版 Crybaby GCB-95 哇音踏板 DSP 核——单一来源(ADR-0003)。
 *
 * 链路:
 *   输入 → Crybaby 三 BJT 白盒电路(输入缓冲射随 + 集电极反馈偏置增益级
 *          + 射随 Miller 可变电容 + 500mH 电感谐振腔,9 节点隐式 Newton)
 *   → LEVEL(线性,dB 域由外层转换)→ 输出
 *   内部 4x 过采样(resample.dsp.js)。每通道独立链路状态。
 *
 * 双模式消费:worklet(crybabyWorklet.ts)经 `?raw` 取本文件源码字符串,
 * 与 wrapper 拼装进 Blob;eval/测试直接 import。只用单行 import 与内联 export
 * (buildProcessorSource 依赖此约定剥离模块语法)。
 * 本文件以 worklet 内联版为权威逐表达式平移(issue #7;音色零变化;
 * nodeVoltages getter 为评测用附加,不影响数值)。
 */
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from './resample.dsp.js';

const N = 9;
const MAX_ITER = 80;
const TOL = 1e-8;
const STEP_MAX = 0.05;
const EXP_MAX = 40;
const iB0 = 0, iE0 = 1, iB1 = 2, iC1 = 3, iE1 = 4, iB2 = 5, iE2 = 6, iX = 7, iY = 8;

/** NxN 线性方程组(部分主元高斯消元,A/b 就地破坏);奇异时返回 null */
function solveN(A, b, n) {
  for (let col = 0; col < n; col++) {
    let piv = col;
    let pMax = Math.abs(A[col * n + col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(A[r * n + col]);
      if (v > pMax) { pMax = v; piv = r; }
    }
    if (pMax < 1e-30) return null;
    if (piv !== col) {
      for (let c = col; c < n; c++) {
        const t = A[col * n + c]; A[col * n + c] = A[piv * n + c]; A[piv * n + c] = t;
      }
      const tb = b[col]; b[col] = b[piv]; b[piv] = tb;
    }
    const inv = 1 / A[col * n + col];
    for (let r = col + 1; r < n; r++) {
      const f = A[r * n + col] * inv;
      if (f === 0) continue;
      for (let c = col; c < n; c++) A[r * n + c] -= f * A[col * n + c];
      b[r] -= f * b[col];
    }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let acc = b[r];
    for (let c = r + 1; c < n; c++) acc -= A[r * n + c] * x[c];
    const d = A[r * n + r];
    if (Math.abs(d) < 1e-30) return null;
    x[r] = acc / d;
  }
  return x;
}

/**
 * Crybaby GCB-95 三 BJT 白盒电路(伴随模型/梯形积分,与双线性 WDF 等效)。
 * 9 节点全维 Newton + 精确解析 Jacobian;构造时 solveDC(电容开路、
 * 电感=60Ω DCR)并一致初始化全部储能元件状态。
 */
export class CrybabyStage {
  /** @param {number} fs 采样率(含过采样倍率后的实际速率) */
  constructor(fs) {
    this.T = 1 / fs;
    this.Vcc = 9;
    this.Rs = 0;
    this.Is = 2e-14;
    this.BF = 250;
    this.BR = 1;
    this.Vt = 26e-3;
    this.gRb0a = 1 / 2.2e6;
    this.gRb0b = 1 / 1.8e6;
    this.gRe0 = 1 / 10e3;
    this.R1 = 68e3;
    this.gR6 = 1 / 1.5e3;
    this.gR5 = 1 / 22e3;
    this.gR4 = 1 / 390;
    this.gR2 = 1 / 470e3;
    this.gR3 = 1 / 82e3;
    this.gR8 = 1 / 470e3;
    this.gR9 = 1 / 10e3;
    this.gR7 = 1 / 33e3;
    this.GcIn = 2 * 0.01e-6 / this.T;
    this.Gc1 = 2 * 0.01e-6 / this.T;
    this.c1Denom = 1 + this.R1 * this.Gc1;
    this.Gc2 = 2 * 0.01e-6 / this.T;
    this.Gc3 = 2 * 4.7e-6 / this.T;
    this.Gl = this.T / (2 * 0.5);
    this.Rdcr = 60;
    this.lDenom = 1 + this.Rdcr * this.Gl;
    this.gLTran = this.Gl / this.lDenom;
    this.blkR = Math.exp(-2 * Math.PI * 15 * this.T);
    this.gTop = 1 / 50e3;
    this.gBot = 1 / 50e3;
    this.vCinPrev = 0; this.iCinPrev = 0;
    this.vCplPrev = 0; this.iCplPrev = 0;
    this.vC2Prev = 0; this.iC2Prev = 0;
    this.vC3Prev = 0; this.iC3Prev = 0;
    this.lIhPrev = 0;
    this.blkX = 0; this.blkY = 0;
    this.INIT_U = [3.1, 2.4, 0.7, 4.5, 0.07, 2.4, 1.8, 0.7, 0.69];
    this.u = this.INIT_U.slice();
    this.vinPrev = 0;
    this.voutPrev = 0;
    this.iterTotal = 0; this.iterCount = 0;
    this.nonConverged = 0;
    this.solveDC();
  }

  /** 踏板位置 0(跟位/低频)~1(顶位/高频);钳到 [0.02,0.98] 防止零电阻 */
  setPosition(w) {
    const p = Math.min(0.98, Math.max(0.02, w));
    this.gTop = 1 / (p * 100e3);
    this.gBot = 1 / ((1 - p) * 100e3);
  }

  /** 当前节点电压(评测用;构造时 solveDC 求得 DC 工作点) */
  get nodeVoltages() {
    return this.u;
  }

  expArg(v) {
    const x = v / this.Vt;
    return x > EXP_MAX ? Math.exp(EXP_MAX) : x < -EXP_MAX ? 0 : Math.exp(x);
  }

  newtonSolve(ctx, start) {
    const Is = this.Is, BF = this.BF, BR = this.BR, Vt = this.Vt, Vcc = this.Vcc;
    const iBR = 1 + 1 / BR;
    const u = start.slice();
    const F = new Array(N);
    const J = new Array(N * N);

    const evalRes = () => {
      const vB0 = u[iB0], vE0 = u[iE0], vB1 = u[iB1], vC1 = u[iC1], vE1 = u[iE1];
      const vB2 = u[iB2], vE2 = u[iE2], vX = u[iX], vY = u[iY];
      const eBe0 = this.expArg(vB0 - vE0);
      const eBc0 = this.expArg(vB0 - Vcc);
      const eBe1 = this.expArg(vB1 - vE1);
      const eBc1 = this.expArg(vB1 - vC1);
      const eBe2 = this.expArg(vB2 - vE2);
      const eBc2 = this.expArg(vB2 - Vcc);

      const if0 = Is * (eBe0 - 1), ir0 = Is * (eBc0 - 1);
      const ib0 = if0 / BF + ir0 / BR;
      const ie0 = if0 * (1 + 1 / BF) + ir0;
      const if1 = Is * (eBe1 - 1), ir1 = Is * (eBc1 - 1);
      const ic1 = if1 - ir1 * iBR;
      const ib1 = if1 / BF + ir1 / BR;
      const ie1 = if1 * (1 + 1 / BF) + ir1;
      const if2 = Is * (eBe2 - 1), ir2 = Is * (eBc2 - 1);
      const ib2 = if2 / BF + ir2 / BR;
      const ie2 = if2 * (1 + 1 / BF) + ir2;

      const iCin = ctx.iInConst - ctx.gIn * vB0;
      const iCpl = ctx.gCpl * (vE0 - vB1) + ctx.iCplH;
      const iC2 = ctx.gC2 * (vE2 - vX) + ctx.iC2h;
      const iC3 = ctx.gC3 * vY + ctx.iC3h;
      const iL = ctx.gL * (vX - vY) + ctx.iLh;

      F[iB0] = (vB0 - Vcc) * this.gRb0a + vB0 * this.gRb0b + ib0 - iCin;
      F[iE0] = vE0 * this.gRe0 + iCpl - ie0;
      F[iB1] = -iCpl + (vB1 - vX) * this.gR6 + ib1;
      F[iC1] = (vC1 - Vcc) * this.gR5 + (vC1 - vY) * this.gR2 +
        (vC1 - vB2) * (this.gR8 + this.gTop) + ic1;
      F[iE1] = vE1 * this.gR4 - ie1;
      F[iB2] = (vB2 - vC1) * (this.gR8 + this.gTop) + vB2 * this.gBot + ib2;
      F[iE2] = vE2 * this.gR9 + iC2 - ie2;
      F[iX] = (vX - vB1) * this.gR6 - iC2 + iL + (vX - vY) * this.gR7;
      F[iY] = (vY - vC1) * this.gR2 + vY * this.gR3 + iC3 - iL + (vY - vX) * this.gR7;
      return { eBe0, eBc0, eBe1, eBc1, eBe2, eBc2 };
    };

    const buildJ = (e) => {
      J.fill(0);
      const s = Is / Vt;
      const gBe0 = s * e.eBe0, gBc0 = s * e.eBc0;
      const gBe1 = s * e.eBe1, gBc1 = s * e.eBc1;
      const gBe2 = s * e.eBe2, gBc2 = s * e.eBc2;
      J[iB0 * N + iB0] = this.gRb0a + this.gRb0b + gBe0 / BF + gBc0 / BR + ctx.gIn;
      J[iB0 * N + iE0] = -gBe0 / BF;
      J[iE0 * N + iB0] = -(gBe0 * (1 + 1 / BF) + gBc0);
      J[iE0 * N + iE0] = this.gRe0 + ctx.gCpl + gBe0 * (1 + 1 / BF);
      J[iE0 * N + iB1] = -ctx.gCpl;
      J[iB1 * N + iE0] = -ctx.gCpl;
      J[iB1 * N + iB1] = ctx.gCpl + this.gR6 + gBe1 / BF + gBc1 / BR;
      J[iB1 * N + iC1] = -gBc1 / BR;
      J[iB1 * N + iE1] = -gBe1 / BF;
      J[iB1 * N + iX] = -this.gR6;
      J[iC1 * N + iB1] = gBe1 - gBc1 * iBR;
      J[iC1 * N + iC1] = this.gR5 + this.gR2 + this.gR8 + this.gTop + gBc1 * iBR;
      J[iC1 * N + iE1] = -gBe1;
      J[iC1 * N + iB2] = -(this.gR8 + this.gTop);
      J[iC1 * N + iY] = -this.gR2;
      J[iE1 * N + iB1] = -(gBe1 * (1 + 1 / BF) + gBc1);
      J[iE1 * N + iC1] = gBc1;
      J[iE1 * N + iE1] = this.gR4 + gBe1 * (1 + 1 / BF);
      J[iB2 * N + iC1] = -(this.gR8 + this.gTop);
      J[iB2 * N + iB2] = this.gR8 + this.gTop + this.gBot + gBe2 / BF + gBc2 / BR;
      J[iB2 * N + iE2] = -gBe2 / BF;
      J[iE2 * N + iB2] = -(gBe2 * (1 + 1 / BF) + gBc2);
      J[iE2 * N + iE2] = this.gR9 + ctx.gC2 + gBe2 * (1 + 1 / BF);
      J[iE2 * N + iX] = -ctx.gC2;
      J[iX * N + iB1] = -this.gR6;
      J[iX * N + iE2] = -ctx.gC2;
      J[iX * N + iX] = this.gR6 + ctx.gC2 + ctx.gL + this.gR7;
      J[iX * N + iY] = -(ctx.gL + this.gR7);
      J[iY * N + iC1] = -this.gR2;
      J[iY * N + iX] = -(ctx.gL + this.gR7);
      J[iY * N + iY] = this.gR2 + this.gR3 + ctx.gC3 + ctx.gL + this.gR7;
    };

    let exps = evalRes();
    let rMax = 0;
    for (let i = 0; i < N; i++) rMax = Math.max(rMax, Math.abs(F[i]));

    let iter = 0;
    for (; iter < ctx.maxIter && rMax >= TOL; iter++) {
      buildJ(exps);
      for (let i = 0; i < N; i++) F[i] = -F[i];
      const dx = solveN(J, F, N);
      if (!dx) break;
      // 非有限步长(残差含 Inf 时):判失败,交由延拓/冻结处理
      let dxBad = false;
      for (let i = 0; i < N; i++) {
        if (!Number.isFinite(dx[i])) { dxBad = true; break; }
      }
      if (dxBad) break;
      let full = true;
      for (let i = 0; i < N; i++) if (Math.abs(dx[i]) > STEP_MAX) { full = false; break; }
      const damp = full ? 1 : 0.5;
      for (let i = 0; i < N; i++) {
        let d = dx[i] * damp;
        if (d > STEP_MAX) d = STEP_MAX; else if (d < -STEP_MAX) d = -STEP_MAX;
        u[i] += d;
        // 物理盒约束 ±12V,NaN 安全(NaN 落到下界)
        if (!(u[i] > -12)) u[i] = -12; else if (!(u[i] < 12)) u[i] = 12;
      }
      exps = evalRes();
      rMax = 0;
      for (let i = 0; i < N; i++) rMax = Math.max(rMax, Math.abs(F[i]));
    }
    return { u, rMax, iters: iter };
  }

  solveDC() {
    // 永远从固定初始猜测出发:watchdog 复位时不受被污染状态影响
    const s = this.newtonSolve(
      { iInConst: 0, gIn: 0, gCpl: 0, iCplH: 0, gC2: 0, iC2h: 0, gC3: 0, iC3h: 0, gL: 1 / this.Rdcr, iLh: 0, maxIter: 200 },
      this.INIT_U.slice(),
    );
    this.u = s.u;
    const vB0 = this.u[iB0], vE0 = this.u[iE0], vB1 = this.u[iB1], vC1 = this.u[iC1];
    const vE2 = this.u[iE2], vX = this.u[iX], vY = this.u[iY];
    this.vCinPrev = -vB0;
    this.iCinPrev = 0;
    this.vCplPrev = vE0 - vB1;
    this.iCplPrev = 0;
    this.vC2Prev = vE2 - vX;
    this.iC2Prev = 0;
    this.vC3Prev = vY;
    this.iC3Prev = 0;
    this.lIhPrev = (vX - vY) / this.Rdcr;
    this.blkX = vC1;
    this.blkY = 0;
    this.vinPrev = 0;
    this.voutPrev = 0;
  }

  process(vin) {
    // 非有限输入(NaN/±Inf,可能来自上游效果器):不触碰任何状态,输出上一采样
    if (!Number.isFinite(vin)) {
      this.nonConverged++;
      return this.voutPrev;
    }
    const ihIn = -this.GcIn * this.vCinPrev - this.iCinPrev;
    const ihCpl = -this.Gc1 * this.vCplPrev - this.iCplPrev;
    const ih2 = -this.Gc2 * this.vC2Prev - this.iC2Prev;
    const ih3 = -this.Gc3 * this.vC3Prev - this.iC3Prev;
    const inDenom = 1 + this.Rs * this.GcIn;
    const gInEff = this.GcIn / inDenom;
    const gCplEff = this.Gc1 / this.c1Denom;

    const baseCtx = {
      gIn: gInEff,
      gCpl: gCplEff,
      iCplH: ihCpl / this.c1Denom,
      gC2: this.Gc2,
      iC2h: ih2,
      gC3: this.Gc3,
      iC3h: ih3,
      gL: this.gLTran,
      iLh: this.lIhPrev / this.lDenom,
    };

    let s = null;
    let totalIters = 0;
    let vinUsed = vin;
    const ladder = [[1, 0], [2, 0], [4, 0], [8, 0], [16, 0], [16, 1.0], [16, 0.5]];
    for (let li = 0; li < ladder.length; li++) {
      const kMax = ladder[li][0], slew = ladder[li][1];
      vinUsed = slew > 0
        ? this.vinPrev + Math.min(slew, Math.max(-slew, vin - this.vinPrev))
        : vin;
      let u = this.u;
      let failed = false;
      totalIters = 0;
      for (let j = 1; j <= kMax; j++) {
        const vj = this.vinPrev + (vinUsed - this.vinPrev) * (j / kMax);
        const r = this.newtonSolve(
          { iInConst: gInEff * vj + ihIn / inDenom, gIn: baseCtx.gIn, gCpl: baseCtx.gCpl,
            iCplH: baseCtx.iCplH, gC2: baseCtx.gC2, iC2h: baseCtx.iC2h,
            gC3: baseCtx.gC3, iC3h: baseCtx.iC3h, gL: baseCtx.gL, iLh: baseCtx.iLh,
            maxIter: MAX_ITER },
          u,
        );
        totalIters += r.iters;
        // 严格判据:只有 rMax < TOL 才算收敛(NaN 残差一律判失败,走下一级延拓)
        if (r.rMax < TOL) { u = r.u; } else { failed = true; break; }
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
    // 数值防御:解出非有限值时重置到 DC 工作点(理论上不可达;
    // 一旦 NaN 进入伴随历史会永久死寂,必须在这里截断)
    if (!s.every(Number.isFinite)) {
      this.nonConverged++;
      this.solveDC();
      return 0;
    }
    this.vinPrev = vinUsed;
    this.u = s;
    const vB0 = this.u[iB0], vE0 = this.u[iE0], vB1 = this.u[iB1], vC1 = this.u[iC1];
    const vE2 = this.u[iE2], vX = this.u[iX], vY = this.u[iY];

    const iCin = gInEff * vinUsed + ihIn / inDenom - gInEff * vB0;
    this.vCinPrev = vinUsed - iCin * this.Rs - vB0;
    this.iCinPrev = iCin;
    const iCpl = gCplEff * (vE0 - vB1) + ihCpl / this.c1Denom;
    this.vCplPrev = vE0 - iCpl * this.R1 - vB1;
    this.iCplPrev = iCpl;
    const vC2 = vE2 - vX;
    this.vC2Prev = vC2;
    this.iC2Prev = this.Gc2 * vC2 + ih2;
    this.vC3Prev = vY;
    this.iC3Prev = this.Gc3 * vY + ih3;
    const vXY = vX - vY;
    const iL = this.gLTran * vXY + baseCtx.iLh;
    const vL = vXY - iL * this.Rdcr;
    this.lIhPrev = iL + this.Gl * vL;

    const y = vC1 - this.blkX + this.blkR * this.blkY;
    // 看门狗:输出非有限(理论上到不了这里)则复位到 DC 工作点自愈
    if (!Number.isFinite(y)) {
      this.solveDC();
      return 0;
    }
    this.blkX = vC1;
    this.blkY = y;

    this.voutPrev = y;
    return y;
  }
}

/**
 * Crybaby 全链路引擎。process(inputs, outputs, params) 语义与
 * AudioWorkletProcessor.process 一致;采样率由构造注入(替代 worklet 全局
 * sampleRate),引擎内不含任何 AudioWorklet API。
 * position 为 a-rate:逐样本读取 params.position(常量数组时退化为 k-rate)。
 */
export class WdfCrybabyEngine {
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
      stage: new CrybabyStage(fs),
      up: new Upsampler4x(this.fir),
      down: new Decimator4x(this.fir),
      lastPos: -1,
    };
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    while (this.chains.length < input.length) this.chains.push(this.createChain());

    const level = params.level[0];
    const posArr = params.position;
    const osIn = new Float32Array(OS_FACTOR);
    const osOut = new Float32Array(OS_FACTOR);

    for (let ch = 0; ch < input.length; ch++) {
      const c = this.chains[ch];
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) {
        // a-rate:逐样本摇杆位置(常量数组时退化为 k-rate)
        const pos = (posArr.length > 1 ? posArr[i] : posArr[0]) / 100;
        if (pos !== c.lastPos) {
          c.stage.setPosition(pos);
          c.lastPos = pos;
        }
        c.up.process(osIn, inp[i]);
        for (let k = 0; k < OS_FACTOR; k++) osOut[k] = c.stage.process(osIn[k]);
        out[i] = c.down.process(osOut[0], osOut[1], osOut[2], osOut[3]) * level;
      }
    }
    return true;
  }
}
