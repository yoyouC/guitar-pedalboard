/**
 * WDF 版 Electro-Harmonix Big Muff Pi(V3,1976-77)——TS 参考实现,Node 可测。
 * worklet(src/audio/wdf/bigmuffWorklet.ts)内联同一套逻辑——改动请两边同步。
 *
 * 电路结构(ElectroSmash Big Muff Pi Analysis,V3 元件值):
 *   输入缓冲(略)→ SUSTAIN 分压(100k 线性电位器,R23 防截止略)
 *   → C3 100nF 耦合 HP(~90Hz)→ BJT 削波级 1(Q2 2N5088,Rc=10k/Re=150/Rf=470k)
 *     集电极反并联 1N4148 对地削波(D1/D2)
 *   → C13 100nF 级间 HP(~155Hz)→ 级2 输入 Miller 等效 LP(~920Hz)
 *   → BJT 削波级 2(Q3 同构,D3/D4 对地)
 *   → C7 1uF 输出耦合 HP(~3.2Hz)→ Rsrc=10k(级2 集电极输出阻抗)
 *   → TONE 无源交叉淡化:LP 臂 R8=39k→C8=10nF→地;HP 臂 C9=4nF→R5=22k→地;
 *     100k 电位器在两臂节点间,滑点输出 =(1-t)·vA + t·vB(中位 ~1kHz 中频大凹陷)
 *   → 输出缓冲(略,单位增益)→ LEVEL
 *
 * BJT 级理想化为"反相增益块 + 戴维南输出电阻 + 二极管对"——与 TS808 的
 * "理想运放"路线一致:二极管钳位在 ±0.6V,BJT 始终在线性区,器件物理由
 * ngspice 全 BJT 小信号扫频校准注入(2N5088,Rc=10k/Re=150/Rf=470k,Cm=470p):
 *
 *   f(Hz)   100    300    500    1k     2k    3k    5k    8k    12k
 *   A1      16.5   15.8   14.4   11.6   7.5   5.3   3.2   1.8   1.1   (src→c1)
 *   A2      22.1   36.8   39.8   41.2  41.5  41.6  41.4  43.4  43.8   (c1→c2)
 *
 * 据此取值(中频带平台 + 极点拟合):
 *   A1=16(反相),Rth1=6.9k(Rc1||Rf1||级2输入阻抗)
 *   A2=42(反相),Rth2=9.8k(Rc2||Rf2;音调网络负载效应略,见妥协说明)
 *   级间 LP 920Hz ≈ 级2 输入 Miller 电容 Cm·(1+|A2|) 对级1集电极的加载极点;
 *   该 LP 是冻结线性化——重削波时真实电路增益塌陷、带宽回升,本模型不还原(妥协)。
 *
 * 已知妥协(v1):
 * - 音调网络对级2钳位节点的负载不进 Newton(缓冲近似):钳位下二极管阻抗
 *   ~几百 Ω 远小于音调输入阻抗,误差 <2%;小信号下等效为级2增益略偏高。
 * - SUSTAIN 电位器滑变时的源阻抗变化(10k~25k)忽略,分压取理想线性。
 * - BJT 自身饱和/截止硬削波不建模(二极管先钳位,物理上成立)。
 *
 * 求解:每级每样本 1D Newton,F(vc)=2·Is·sinh(vc/nVt)+(vc-vth)/Rth=0,
 * 解析 Jacobian、步长阻尼、初值沿用上一样本(同 diodeClipper.ts)。
 */

import { DIODE_1N4148, type DiodeParams } from './diodeClipper.ts';

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
} as const;

const MAX_ITER = 12;
const TOL = 1e-12;
/** 二极管电压钳制(防 sinh 溢出;物理上超不过 ±0.9V) */
const VC_CLAMP = 1.0;

/** 一阶高通(双线性):y[n]=a1·y[n-1]+b0·(x[n]-x[n-1]) */
export class OnePoleHP {
  private readonly b0: number;
  private readonly a1: number;
  private x1 = 0;
  private y1 = 0;

  constructor(fs: number, fc: number) {
    const K = 2 * fs;
    const w = 2 * Math.PI * fc;
    this.b0 = K / (K + w);
    this.a1 = (K - w) / (K + w);
  }

  process(x: number): number {
    const y = this.a1 * this.y1 + this.b0 * (x - this.x1);
    this.x1 = x;
    this.y1 = y;
    return y;
  }
}

/** 一阶低通(双线性):y[n]=a1·y[n-1]+b0·(x[n]+x[n-1]) */
export class OnePoleLP {
  private readonly b0: number;
  private readonly a1: number;
  private x1 = 0;
  private y1 = 0;

  constructor(fs: number, fc: number) {
    const K = 2 * fs;
    const w = 2 * Math.PI * fc;
    this.b0 = w / (K + w);
    this.a1 = (K - w) / (K + w);
  }

  process(x: number): number {
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
  private readonly A: number;
  private readonly gTh: number; // 1/Rth
  private readonly diode: DiodeParams;
  private vcPrev = 0;

  /** 求解器统计(评测用) */
  iterTotal = 0;
  iterCount = 0;

  constructor(A: number, Rth: number, diode: DiodeParams = DIODE_1N4148) {
    this.A = A;
    this.gTh = 1 / Rth;
    this.diode = diode;
  }

  process(vs: number): number {
    const vth = -this.A * vs;
    const { Is, nVt } = this.diode;
    let vc = this.vcPrev;
    let iter = 0;
    for (; iter < MAX_ITER; iter++) {
      const f = 2 * Is * Math.sinh(vc / nVt) + (vc - vth) * this.gTh;
      if (Math.abs(f) < TOL) break;
      const df = ((2 * Is) / nVt) * Math.cosh(vc / nVt) + this.gTh;
      let step = f / df;
      if (step > 0.2) step = 0.2;
      else if (step < -0.2) step = -0.2;
      vc -= step;
      if (vc > VC_CLAMP) vc = VC_CLAMP;
      else if (vc < -VC_CLAMP) vc = -VC_CLAMP;
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
  private readonly inv: Float64Array = new Float64Array(9); // 3×3 逆(行主序)
  private readonly gC8: number;
  private readonly gC9: number;
  private ih8 = 0; // C8 历史电流
  private ih9 = 0; // C9 历史电流
  private t = 0.5;

  constructor(fs: number) {
    const T = 1 / fs;
    const { TONE_RSRC, TONE_R_LP, TONE_C_LP, TONE_C_HP, TONE_R_HP, TONE_POT } = MUFF;
    this.gC8 = (2 * TONE_C_LP) / T;
    this.gC9 = (2 * TONE_C_HP) / T;
    const gSrc = 1 / TONE_RSRC;
    const gR8 = 1 / TONE_R_LP;
    const gR5 = 1 / TONE_R_HP;
    const gP = 1 / TONE_POT;
    // KCL(未知量 vs,vA,vB):
    // s: vs(gSrc+gR8+gC9) - gR8·vA - gC9·vB      = gSrc·vh - ih9
    // A: -gR8·vs + (gR8+gC8+gP)·vA - gP·vB      = -ih8
    // B: -gC9·vs - gP·vA + (gC9+gR5+gP)·vB      =  ih9
    const m = [
      gSrc + gR8 + this.gC9, -gR8, -this.gC9,
      -gR8, gR8 + this.gC8 + gP, -gP,
      -this.gC9, -gP, this.gC9 + gR5 + gP,
    ];
    // 3×3 伴随求逆
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h;
    const B = c * h - b * i;
    const C = b * f - c * e;
    const det = a * A + d * B + g * C;
    this.inv = new Float64Array([
      A / det, B / det, C / det,
      (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
      (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
    ]);
  }

  /** tone 0~1:0=全 LP(暗),1=全 HP(亮) */
  setTone(t: number): void {
    this.t = Math.min(1, Math.max(0, t));
  }

  process(vh: number): number {
    const inv = this.inv;
    const r0 = vh / MUFF.TONE_RSRC - this.ih9;
    const r1 = -this.ih8;
    const r2 = this.ih9;
    const vs = inv[0] * r0 + inv[1] * r1 + inv[2] * r2;
    const vA = inv[3] * r0 + inv[4] * r1 + inv[5] * r2;
    const vB = inv[6] * r0 + inv[7] * r1 + inv[8] * r2;
    // 更新电容历史:i = G·Δv + ih;ih' = -G·Δv - i
    const i8 = this.gC8 * vA + this.ih8;
    this.ih8 = -this.gC8 * vA - i8;
    const dv9 = vs - vB;
    const i9 = this.gC9 * dv9 + this.ih9;
    this.ih9 = -this.gC9 * dv9 - i9;
    return (1 - this.t) * vA + this.t * vB;
  }
}

/**
 * 完整 Big Muff 链(过采样速率下运行;升/降采样在外层,同 ts808 模式)。
 */
export class BigMuffChain {
  readonly stage1: MuffClipStage;
  readonly stage2: MuffClipStage;
  private readonly hpIn: OnePoleHP;
  private readonly hpMid: OnePoleHP;
  private readonly lpMid: OnePoleLP;
  private readonly hpOut: OnePoleHP;
  private readonly tone: MuffTone;
  private sustain = 0.5;

  constructor(fs: number) {
    this.hpIn = new OnePoleHP(fs, MUFF.FC_HP_IN);
    this.stage1 = new MuffClipStage(MUFF.A1, MUFF.RTH1);
    this.hpMid = new OnePoleHP(fs, MUFF.FC_HP_MID);
    this.lpMid = new OnePoleLP(fs, MUFF.FC_LP_MID);
    this.stage2 = new MuffClipStage(MUFF.A2, MUFF.RTH2);
    this.hpOut = new OnePoleHP(fs, MUFF.FC_HP_OUT);
    this.tone = new MuffTone(fs);
  }

  /** sustain 0~1:SUSTAIN 电位器分压(第一级驱动) */
  setSustain(k: number): void {
    this.sustain = Math.min(1, Math.max(0, k));
  }

  /** tone 0~1 */
  setTone(t: number): void {
    this.tone.setTone(t);
  }

  process(x: number): number {
    return this.processWithTaps(x).out;
  }

  /** 与 process 相同,另返回两级削波节点(评测用) */
  processWithTaps(x: number): { out: number; c1: number; c2: number } {
    const u1 = this.hpIn.process(this.sustain * x);
    const c1 = this.stage1.process(u1);
    const u2 = this.lpMid.process(this.hpMid.process(c1));
    const c2 = this.stage2.process(u2);
    return { out: this.tone.process(this.hpOut.process(c2)), c1, c2 };
  }
}
