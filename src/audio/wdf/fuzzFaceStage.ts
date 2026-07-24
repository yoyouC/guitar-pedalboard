/**
 * WDF 版 Fuzz Face 两级锗管放大级(伴随模型/梯形积分,与双线性 WDF 等效)。
 *
 * 电路(经典 Dallas-Arbiter 负接地 NPN 版,R.G. Keen "The Technology of the Fuzz Face"):
 *   Vcc=9V
 *   输入 → Rs(10k,拾音源内阻)→ Cin(2.2uF)→ Q1 基极
 *   Q1:发射极接地,集电极 33k → Vcc;集电极直耦 Q2 基极
 *   Q2:分裂集电极负载 8.2k + 470(输出取两电阻交点 ≈ 集电极摆幅 × 5.4%);
 *       发射极 → Rtop ─ 动片 ─ Rbot → 地(1k FUZZ 电位器),
 *       动片经 20uF 交流旁路到地 → DC 发射极电阻恒 1k,AC 电阻 = Rtop
 *   电压反馈偏置:Q2 发射极 → 100k → Q1 基极(Keen 原文:实为发射极反馈;
 *       某些二手资料写成集电极反馈,那是 DC 正反馈,直接闩锁不可工作)
 *   输出:交点 → Cout(0.01uF)→ Rload(500k,LEVEL 全开)
 *
 * BJT:简化 Ebers-Moll(注入式,含 BC 结——Q1 的"糊状"饱和软削波正源于此):
 *   If = Is·(e^(Vbe/Vt)-1),  Ir = Is·(e^(Vbc/Vt)-1)
 *   Ic = If - Ir·(1+1/BR),  Ib = If/BF + Ir/BR,  Ie = If·(1+1/BF) + Ir
 * 参数:AC128 类锗管 Is=1e-7(实测 Vbe≈0.1~0.2V @0.5mA;1e-14 是硅管量级,
 *   会把 Q2 集电极偏置压到 ~1.4V,偏离经典 4.5V),BF=80,BR=1,Vt=26mV。
 *
 * 每样本:3 变量隐式 Newton(u = vb1, vc1, ve2),精确解析 Jacobian
 * (vc2 敏感性按内层不动方程隐函数定理折算),回溯线搜索;
 * vc2 由集电极线性网络闭式消元(safeguarded 1D Newton,单调有括号必收敛)。
 * 构造时先做 DC 工作点求解(电容开路)并一致初始化全部状态,
 * 避免零状态启动的充电瞬态风暴(同 ngspice 先 OP 后 tran)。
 */
export interface FuzzFaceOptions {
  /** 采样率(含过采样倍率后的实际速率) */
  fs: number;
  Vcc?: number;   // 电源,默认 9V
  Rs?: number;    // 输入源内阻(拾音模拟),默认 10k
  Is?: number;    // BJT 饱和电流,默认 1e-7(AC128 量级)
  BF?: number;    // 正向 β,默认 80
  BR?: number;    // 反向 β,默认 1(ngspice 默认)
  Vt?: number;    // 热电压,默认 26mV
}

const MAX_ITER = 80;
const TOL = 1e-8;
/** Newton 单步电压限幅(V),防大步长发散 */
const STEP_MAX = 0.05;
/** exp 自变量上限(防溢出;正常工作区远达不到) */
const EXP_MAX = 40;

/** newtonSolve 的每样本上下文(线性网络消元常量与输入端口) */
interface SolveCtx {
  /** iCin 作为 vb1 候选值的函数(DC 时为常 0) */
  iCinAt: (a: number) => number;
  /** ∂iCin/∂vb1(≤0;DC 时为 0) */
  gIn: number;
  /** Q2 发射极一端口戴维南等效 */
  reqE2: number;
  vhE2: number;
  /** vc2 = A + B·Ic2(集电极线性网络消元) */
  A: number;
  B: number;
  maxIter: number;
}

interface SolveOut {
  vb1: number;
  vc1: number;
  ve2: number;
  vc2: number;
  rMax: number;
  iters: number;
}

export class FuzzFaceStage {
  private readonly T: number;
  private readonly Vcc: number;
  private readonly Rs: number;
  private readonly Is: number;
  private readonly BF: number;
  private readonly BR: number;
  private readonly Vt: number;

  // 元件值
  private readonly Rc1 = 33e3;
  private readonly Rc2a = 8.2e3;
  private readonly Rc2b = 470;
  private readonly Rfb = 100e3;
  private readonly Rload = 500e3;
  private readonly GcIn: number;  // Cin 2.2uF 伴随电导
  private readonly GcK: number;   // 20uF 伴随电导
  private readonly GcO: number;   // Cout 0.01uF 伴随电导
  private readonly dO: number;    // Cout/Rload 分压因子 1+GcO·Rload

  // FUZZ 电位器(fuzz=1 最大增益:Rtop=0)
  private Rtop = 500;
  private Rbot = 500;

  // 电容状态(上一采样)
  private vCinPrev = 0;
  private iCinPrev = 0;
  private vwPrev = 0;
  private iCkPrev = 0;
  private vCoutPrev = 0;
  private iCoutPrev = 0;

  // Newton 初值沿用上一采样(初始为 DC 工作点,由 solveDC 填入)
  private vb1 = 0.2;
  private vc1 = 0.72;
  private ve2 = 0.5;
  private vc2 = 4.7;
  private vinPrev = 0;

  /** 求解器统计(评测用) */
  iterTotal = 0;
  iterCount = 0;
  /** 未收敛回退次数(应为 0 或极少) */
  nonConverged = 0;
  private voutPrev = 0;

  constructor(opts: FuzzFaceOptions) {
    this.T = 1 / opts.fs;
    this.Vcc = opts.Vcc ?? 9;
    this.Rs = opts.Rs ?? 10e3;
    this.Is = opts.Is ?? 1e-7;
    this.BF = opts.BF ?? 80;
    this.BR = opts.BR ?? 1;
    this.Vt = opts.Vt ?? 26e-3;
    this.GcIn = (2 * 2.2e-6) / this.T;
    this.GcK = (2 * 20e-6) / this.T;
    this.GcO = (2 * 0.01e-6) / this.T;
    this.dO = 1 + this.GcO * this.Rload;
    this.solveDC();
  }

  /** fuzz 0~1:1 = 最大增益(动片到顶,发射极 AC 接地) */
  setFuzz(fuzz: number): void {
    const f = Math.min(1, Math.max(0, fuzz));
    this.Rtop = (1 - f) * 1000;
    this.Rbot = f * 1000;
  }

  private expArg(v: number): number {
    const x = v / this.Vt;
    return x > EXP_MAX ? Math.exp(EXP_MAX) : x < -EXP_MAX ? 0 : Math.exp(x);
  }

  /**
   * 核心 3 变量阻尼 Newton:解 B1/C1/E2 三节点 KCL。
   * 不触碰状态;从 start 出发,返回解与收敛残差。DC/瞬态/延拓子步共用。
   */
  private newtonSolve(
    ctx: SolveCtx,
    start: { vb1: number; vc1: number; ve2: number; vc2: number },
  ): SolveOut {
    const { Is, BF, BR, Vt } = this;
    const iBR = 1 + 1 / BR;
    let vb1 = start.vb1;
    let vc1 = start.vc1;
    let ve2 = start.ve2;
    let vc2 = start.vc2;

    // 残差评估(含 Q2 内层 vc2 求解)
    const evalRes = (a: number, b: number, c: number, vc2g: number) => {
      const eBe1 = this.expArg(a);
      const eBc1 = this.expArg(a - b);
      const if1 = Is * (eBe1 - 1);
      const ir1 = Is * (eBc1 - 1);
      const ic1 = if1 - ir1 * iBR;
      const ib1 = if1 / BF + ir1 / BR;
      // Q1 B-E 反向击穿软化:Vbr=4V 以下的平滑指数通路。
      // 音频区永不触发(vbe1 ≥ -0.5V 时 ≈ 1e-25 A);大负向输入时为 Cin
      // 提供泄放路径,否则简化 Ebers-Moll 无反向电流、KCL 在数学上无解
      // (ngspice 内置 NPN 同样无 B-E 击穿,参考侧行为一致)。
      const xBr = -(a + 4) / 0.1;
      const eBr = xBr > EXP_MAX ? Math.exp(EXP_MAX) : xBr < -EXP_MAX ? 0 : Math.exp(xBr);
      const ibd = -1e-6 * eBr;

      const vbe2 = b - c;
      const eBe2 = this.expArg(vbe2);
      // 内层 vc2:g(v2)=v2-A-B·Ic2(v2) 严格单增(dg/dv2>1),
      // safeguarded Newton(括号 [-2,12],出界退二分)必收敛。
      // 迭代给足 40 次:内层不精确收敛会把误差地板抬进外层残差造成停滞。
      let lo = -2;
      let hi = 12;
      let v2 = vc2g < lo ? lo + 1e-6 : vc2g > hi ? hi - 1e-6 : vc2g;
      let eBc2 = 0;
      for (let k = 0; k < 40; k++) {
        eBc2 = this.expArg(b - v2);
        const ic2k = Is * (eBe2 - 1) - Is * (eBc2 - 1) * iBR;
        const g = v2 - ctx.A - ctx.B * ic2k;
        if (Math.abs(g) < 1e-9 || hi - lo < 1e-9) break;
        if (g > 0) hi = v2;
        else lo = v2;
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
      // 精确解析 Jacobian:vc2 对 vc1/ve2 的敏感性按内层不动方程
      // g=vc2-A-B·Ic2=0 隐函数定理折算(dvc2/dvc1=p1, dvc2/dve2=p3)
      const gBe1 = (Is / Vt) * cur.eBe1;
      const gBc1 = (Is / Vt) * cur.eBc1;
      const gBe2 = (Is / Vt) * cur.eBe2;
      const gBc2 = (Is / Vt) * cur.eBc2;
      const gB2 = gBc2 * iBR; // -∂Ic2/∂vbc2
      const dDenom = 1 - ctx.B * gB2;
      const p1 = (ctx.B * (gBe2 - gB2)) / dDenom;
      const p3 = (-ctx.B * gBe2) / dDenom;
      // R1 = iCin - ib1 - ibd - (vb1-ve2)/Rfb
      const j11 = ctx.gIn - (gBe1 / BF + gBc1 / BR) - (1e-6 / 0.1) * cur.eBr - 1 / this.Rfb;
      const j12 = gBc1 / BR;
      const j13 = 1 / this.Rfb;
      // R2 = (Vcc-vc1)/Rc1 - ic1 - ib2
      const j21 = -(gBe1 - gBc1 * iBR);
      const j22 = -1 / this.Rc1 - gBc1 * iBR - (gBe2 / BF + (gBc2 / BR) * (1 - p1));
      const j23 = gBe2 / BF + (gBc2 / BR) * p3;
      // R3 = ie2 - (ve2-vhE2)/reqE2 - (ve2-vb1)/Rfb
      const j31 = 1 / this.Rfb;
      const j32 = gBe2 * (1 + 1 / BF) + gBc2 * (1 - p1);
      const j33 = -gBe2 * (1 + 1 / BF) - gBc2 * p3 - 1 / ctx.reqE2 - 1 / this.Rfb;

      const dx = solve3(
        j11, j12, j13, j21, j22, j23, j31, j32, j33,
        -cur.r1, -cur.r2, -cur.r3,
      );
      if (!dx) break;

      // 结电压限步(SPICE vnlim 精神):步长 ≤2·Vt 内用完整 Newton 步
      // (解附近二次收敛);超限才阻尼 0.5(防悬崖区周期振荡)。无条件接受
      // (严格下降的回溯在本电路不可行:进入饱和区必须先"翻山",
      // 即 vc1 越过 vb1 使 BC 结导通,rMax 沿路径非单调)。
      const full =
        Math.abs(dx[0]) <= STEP_MAX && Math.abs(dx[1]) <= STEP_MAX && Math.abs(dx[2]) <= STEP_MAX;
      const damp = full ? 1 : 0.5;
      let d1 = dx[0] * damp;
      let d2 = dx[1] * damp;
      let d3 = dx[2] * damp;
      if (d1 > STEP_MAX) d1 = STEP_MAX; else if (d1 < -STEP_MAX) d1 = -STEP_MAX;
      if (d2 > STEP_MAX) d2 = STEP_MAX; else if (d2 < -STEP_MAX) d2 = -STEP_MAX;
      if (d3 > STEP_MAX) d3 = STEP_MAX; else if (d3 < -STEP_MAX) d3 = -STEP_MAX;
      vb1 += d1;
      vc1 += d2;
      ve2 += d3;
      // 物理盒约束:输入耦合电容可把基极拉到电源轨之外(±12V 留裕量),
      // 过紧的下界会让大负向输入的 KCL 无解(vb1 必须能到 vin-vCin)
      if (vb1 > 12) vb1 = 12; else if (vb1 < -12) vb1 = -12;
      if (vc1 > 12) vc1 = 12; else if (vc1 < -12) vc1 = -12;
      if (ve2 > 12) ve2 = 12; else if (ve2 < -12) ve2 = -12;
      cur = evalRes(vb1, vc1, ve2, vc2);
      vc2 = cur.vc2;
      rMax = Math.max(Math.abs(cur.r1), Math.abs(cur.r2), Math.abs(cur.r3));
    }
    return { vb1, vc1, ve2, vc2, rMax, iters: iter };
  }

  /**
   * DC 工作点求解(全部电容开路,输入 0):同 ngspice 先 OP 后 tran。
   * 解出偏置后一致初始化所有电容状态,消除零启动充电瞬态。
   */
  private solveDC(): void {
    const s = this.newtonSolve(
      {
        iCinAt: () => 0,
        gIn: 0,
        reqE2: 1000, // Rtop+Rbot 恒 1k(与 fuzz 无关)
        vhE2: 0,
        A: this.Vcc, // vc2 = Vcc - (Rc2a+Rc2b)·Ic2
        B: -(this.Rc2a + this.Rc2b),
        maxIter: 50,
      },
      { vb1: this.vb1, vc1: this.vc1, ve2: this.ve2, vc2: this.vc2 },
    );
    this.vb1 = s.vb1;
    this.vc1 = s.vc1;
    this.ve2 = s.ve2;
    this.vc2 = s.vc2;
    // 由偏置电流推各电容稳态电压( companion 电流恒 0)
    const { Is, BF, BR, Vt } = this;
    const iBR = 1 + 1 / BR;
    const eBe2 = this.expArg(s.vc1 - s.ve2);
    const eBc2 = this.expArg(s.vc1 - s.vc2);
    const ic2 = Is * (eBe2 - 1) - Is * (eBc2 - 1) * iBR;
    const vx = this.Vcc - ic2 * this.Rc2a;
    this.vCinPrev = -s.vb1; // Cin 左端为源 DC=0
    this.iCinPrev = 0;
    this.vwPrev = s.ve2 * (this.Rbot / 1000); // DC:动片电压 = ie2·Rbot
    this.iCkPrev = 0;
    this.vCoutPrev = vx; // out 端 DC=0(Rload 到地)
    this.iCoutPrev = 0;
    this.voutPrev = 0;
    void BF;
    void Vt;
  }

  /**
   * 处理一个样本。vin 为源电压(V,吉他电平),
   * 返回经 Cout 后的输出电压(V,500k 负载上)。
   */
  process(vin: number): number {
    // 步骤开始:由上一状态推出各电容历史电流(等价 WDF 中 b[n]=a[n-1])
    const ihIn = -this.GcIn * this.vCinPrev - this.iCinPrev;
    const ihK = -this.GcK * this.vwPrev - this.iCkPrev;
    const ihO = -this.GcO * this.vCoutPrev - this.iCoutPrev;

    // Q2 发射极一端口: Rtop + (Rbot || Ck伴随) → 戴维南 (reqE2, vhE2)
    // 注意 Rbot=0(fuzz=0)时动片直接接地、电容被短路 → reqS=0;
    // 不能把 1/Rbot 的守卫写成 gBot=0,那会把短路易错成开路(电容阻断 DC)。
    const reqS = this.Rbot > 1e-9 ? 1 / (this.GcK + 1 / this.Rbot) : 0;
    const reqE2 = this.Rtop + reqS;
    const vhE2 = -ihK * reqS;

    // Q2 集电极线性网络消元:vc2 = A + B·Ic2
    //   X 节点 KCL:(Vcc-vx)/Rc2a = Ic2 + (GcO·vx + ihO)/dO
    const kA = this.Vcc / this.Rc2a - ihO / this.dO;
    const kB = 1 / this.Rc2a + this.GcO / this.dO;
    const A = kA / kB;
    const B = -(1 / kB + this.Rc2b);

    // 输入端口(Rs 与 Cin 串联消元):iCin = (GcIn·(vin-vb1) + ihIn)/(1+Rs·GcIn)
    const inDenom = 1 + this.Rs * this.GcIn;
    const gInEff = this.GcIn / inDenom;

    // 数值延拓(continuation):沿 vin 斜坡(vinPrev→vin)分 K 个子步求解,
    // 每个子步以上一个的解为初值;子步不更新电容状态、不改变离散化,
    // 最终解与直接求解 vin 完全一致——只是给 Newton 一条可跟踪的路径。
    // K 从 1 起,未收敛则翻倍(≤8);最后一级对输入步长限摆 ±1V/样本
    // (仅病理级 DC 阶跃触发;音频经 4x 多相升采样后单样本变化远小于此),
    // 使状态能在后续样本中追平,避免永久性冻结。
    let s: SolveOut | null = null;
    let totalIters = 0;
    let vinUsed = vin;
    const ladder: [number, number][] = [[1, 0], [2, 0], [4, 0], [8, 0], [8, 0.5]];
    for (const [kMax, slew] of ladder) {
      vinUsed =
        slew > 0
          ? this.vinPrev + Math.min(slew, Math.max(-slew, vin - this.vinPrev))
          : vin;
      let u = { vb1: this.vb1, vc1: this.vc1, ve2: this.ve2, vc2: this.vc2 };
      let failed = false;
      totalIters = 0;
      for (let j = 1; j <= kMax; j++) {
        const vj = this.vinPrev + (vinUsed - this.vinPrev) * (j / kMax);
        const r = this.newtonSolve(
          {
            iCinAt: (a) => gInEff * (vj - a) + ihIn / inDenom,
            gIn: -gInEff,
            reqE2,
            vhE2,
            A,
            B,
            maxIter: MAX_ITER,
          },
          u,
        );
        totalIters += r.iters;
        if (r.rMax >= TOL) {
          failed = true;
          break;
        }
        u = r;
      }
      if (!failed) {
        s = u as SolveOut;
        break;
      }
    }
    this.iterTotal += totalIters;
    this.iterCount++;
    if (!s) {
      // 全部兜底仍未收敛:冻结状态输出上一采样(防爆音/发散),仅统计;
      // 输入参考按同档限摆跟进,保证回到可解区间后自行恢复
      this.nonConverged++;
      this.vinPrev += Math.min(0.5, Math.max(-0.5, vin - this.vinPrev));
      return this.voutPrev;
    }
    this.vinPrev = vinUsed;
    const { vb1, vc1, ve2 } = s;
    this.vb1 = s.vb1;
    this.vc1 = s.vc1;
    this.ve2 = s.ve2;
    this.vc2 = s.vc2;

    // --- 状态更新(用实际求解的 vinUsed,限摆兜底时保持电容状态一致) ---
    // Cin
    const iCin = gInEff * (vinUsed - vb1) + ihIn / inDenom;
    this.vCinPrev = vinUsed - iCin * this.Rs - vb1;
    this.iCinPrev = iCin;
    // 20uF(动片):由最终解取发射极端口电流
    const iEPort = (ve2 - vhE2) / reqE2;
    const vw = ve2 - iEPort * this.Rtop;
    if (this.Rbot > 1e-9) {
      const iCk = this.GcK * vw + ihK;
      this.vwPrev = vw;
      this.iCkPrev = iCk;
    } else {
      // Rbot=0:动片直接接地,电容被短路,状态清零(防 fuzz 扫回时垃圾瞬态)
      this.vwPrev = 0;
      this.iCkPrev = 0;
    }
    // Cout:vx → out
    const { Is, BF, BR } = this;
    const iBR = 1 + 1 / BR;
    const eBe2 = this.expArg(vc1 - ve2);
    const eBc2 = this.expArg(vc1 - this.vc2);
    const ic2 = Is * (eBe2 - 1) - Is * (eBc2 - 1) * iBR;
    void BF;
    const vx = (kA - ic2) / kB;
    const iCout = (this.GcO * vx + ihO) / this.dO;
    const vout = this.Rload * iCout;
    this.vCoutPrev = vx - vout;
    this.iCoutPrev = iCout;

    this.voutPrev = vout;
    return vout;
  }
}

/** 3x3 线性方程组(部分主元高斯消元);奇异时返回 null */
function solve3(
  a11: number, a12: number, a13: number,
  a21: number, a22: number, a23: number,
  a31: number, a32: number, a33: number,
  b1: number, b2: number, b3: number,
): [number, number, number] | null {
  // 列1主元
  const p = Math.abs(a11) > Math.abs(a21) ? (Math.abs(a11) > Math.abs(a31) ? 0 : 2) : (Math.abs(a21) > Math.abs(a31) ? 1 : 2);
  let r1: number[] = [a11, a12, a13, b1];
  let r2: number[] = [a21, a22, a23, b2];
  let r3: number[] = [a31, a32, a33, b3];
  if (p === 1) { const t = r1; r1 = r2; r2 = t; }
  else if (p === 2) { const t = r1; r1 = r3; r3 = t; }
  if (Math.abs(r1[0]) < 1e-30) return null;
  let f = r2[0] / r1[0];
  for (let c = 0; c < 4; c++) r2[c] -= f * r1[c];
  f = r3[0] / r1[0];
  for (let c = 0; c < 4; c++) r3[c] -= f * r1[c];
  // 列2主元
  if (Math.abs(r3[1]) > Math.abs(r2[1])) { const t = r2; r2 = r3; r3 = t; }
  if (Math.abs(r2[1]) < 1e-30) return null;
  f = r3[1] / r2[1];
  for (let c = 1; c < 4; c++) r3[c] -= f * r2[c];
  if (Math.abs(r3[2]) < 1e-30) return null;
  const x3 = r3[3] / r3[2];
  const x2 = (r2[3] - r2[2] * x3) / r2[1];
  const x1 = (r1[3] - r1[2] * x3 - r1[1] * x2) / r1[0];
  return [x1, x2, x3];
}
