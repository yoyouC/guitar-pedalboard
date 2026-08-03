/**
 * WDF 版 Crybaby GCB-95 哇音踏板(伴随模型/梯形积分,与双线性 WDF 等效)。
 *
 * 电路(Dunlop GCB-95,含输入缓冲;来源:
 *   GEO www.geofex.com "The Technology of Wah Pedals"(偏置描述与实测电压:
 *   Q1 集电极 4.14V、Q2 基极 3.64V)+
 *   Electrosmash GCB-95 电路分析(完整 BOM 与各级拆解)):
 *   Vcc=9V;三个 NPN(硅 BC109B/MPSA18 类):Is=2e-14, BF=250, BR=1, Vt=26mV。
 *   Vin → Cin(0.01uF)→ QB 基极;QB 基极偏置 = Rb0a(2.2M)→Vcc + Rb0b(1.8M)→地
 *   QB 射随(集电极直连 Vcc),发射极 → Re0(10k)→ 地
 *   QB 发射极 → C1(0.01uF)→ R1(68k)→ Q1 基极(C1 耦合,隔断直流)
 *   Q1 增益级(集电极反馈偏置):R5(22k)集电极负载,R4(390)发射极退化
 *   R2(470k):vC1 → Y;R3(82k):Y → 地;C3(4.7uF):Y → 地(Y 交流接地)
 *   R6(1.5k):X → Q1 基极(偏置经电感来自集电极 + 谐振腔注入)
 *   R8(470k)与踏板电位器上半 Rtop=w·100k 并联:vC1 → Q2 基极;
 *     下半 Rbot=(1-w)·100k:Q2 基极 → 地(w=踏板位置,0=跟位,1=顶位/高频)
 *   Q2 射随(集电极直连 Vcc):发射极 → R9(10k)→ 地
 *   C2(0.01uF):Q2 发射极 → X(Miller 效应"可变电容",哇音核心)
 *   L1(500mH,串联 60Ω 绕线电阻 DCR):X → Y;R7(33k):X → Y(定 Q)
 *   输出 = vC1(真实踏板输出取自 VR1 之前的集电极节点),经一阶 DC blocker 去直流。
 *
 * 对最初简报网表的两处修正(否则电路不工作,在此记录):
 *   1. 输入缓冲基极偏置:简报为 Rb0 470k→+9V;真实 GCB-95 为 2.2M/1.8M 分压
 *      (Electrosmash BOM: Rin1=2.2M, Rin2=1.8M,输入阻抗 1MΩ)。
 *   2. 缓冲级与增益级之间有耦合电容 C1 0.01uF(Electrosmash: "C1 is a bypass
 *      capacitor that isolates the Input Buffer from the Active filter")。
 *      简报把 R1 68k 直跨 vE0→vB1:缓冲发射极 ~6.9V 经 68k 向 Q1 基极灌 ~90µA,
 *      唯一泄放路径是 BC 结正偏 → Q1 深度饱和(vC1≈0.3V),与 GEO 实测 4.14V
 *      矛盾,谐振峰也不存在。修正后 DC 偏置与 GEO 实测一致。
 *   省略:Rin3/R9 1k 集电极电阻(射随集电极防振,对信号无影响)、Cin2 22pF
 *      (RF 滤波,音频外)、电源滤波网络。
 *
 * 机理(GEO):Y 交流接地,Q2 射随把电位器分压后的集电极信号经 C2 注入 X,
 *   C2 因 Miller 效应表现为可变电容 C_eff=C2·(1+A·p),与 L 形成
 *   ~450Hz~1.6kHz 扫频谐振;Q1 增益给谐振峰 +18dB。
 *
 * 与 fuzzFaceStage 的差异(自选实现,在此记录):
 *   - 9 节点全维 Newton( vB0,vE0,vB1,vC1,vE1,vB2,vE2,vX,vY ),不做解析降维:
 *     反馈环(C2→射随→集电极)跨 4 个节点,全维解析 Jacobian 比隐函数折算
 *     更简单也更不易错;9x9 高斯消元(solveN,部分主元)每样本 ~2 次迭代。
 *   - 项目首例电感:伴随模型与电容对偶 Gl=T/(2L),i[n]=Gl·v[n]+Ih[n-1],
 *     Ih[n]=i[n]+Gl·v[n]。串联 60Ω DCR 永久并入瞬态模型(真实绕线电阻;
 *     DC 求解与瞬态模型一致,消除"DC=60Ω/瞬态=理想L"两模型工作点不一致
 *     的启动瞬态),支路消元:i = (Gl·vXY + Ih)/(1+60·Gl)。
 *   - 输出无耦合电容网表,用一阶 DC blocker(R=exp(-2π·15/fs))去 vC1 直流,
 *     对 wah 通带(≥400Hz)无影响。
 *
 * BJT:与 fuzzface 相同的注入式简化 Ebers-Moll(含 BC 结):
 *   If = Is·(e^(Vbe/Vt)-1),  Ir = Is·(e^(Vbc/Vt)-1)
 *   Ic = If - Ir·(1+1/BR),  Ib = If/BF + Ir/BR,  Ie = If·(1+1/BF) + Ir
 *
 * 构造时 solveDC(电容开路、电感=60Ω)并一致初始化全部电容/电感伴随历史
 * (消启动瞬态,同 ngspice 先 OP 后 tran)。逐样本数值延拓 ladder +
 * 不收敛冻结上一采样(同 fuzzFaceStage)。
 * setPosition(w) 只改两片电位器电阻,逐样本可调,无需重建。
 */
export interface CrybabyOptions {
  /** 采样率(含过采样倍率后的实际速率) */
  fs: number;
  Vcc?: number;   // 电源,默认 9V
  Rs?: number;    // 输入源内阻,默认 0(网表为理想电压源)
  Is?: number;    // BJT 饱和电流,默认 2e-14(硅 BC109B/MPSA18 类)
  BF?: number;    // 正向 β,默认 250
  BR?: number;    // 反向 β,默认 1
  Vt?: number;    // 热电压,默认 26mV
}

const N = 9; // 节点未知量个数
const MAX_ITER = 80;
const TOL = 1e-8;
/** Newton 单步电压限幅(V),防大步长发散 */
const STEP_MAX = 0.05;
/** exp 自变量上限(防溢出;正常工作区远达不到) */
const EXP_MAX = 40;
/** 输出 DC blocker 转角(Hz) */
const DC_BLOCK_HZ = 15;

// 未知量索引
const iB0 = 0, iE0 = 1, iB1 = 2, iC1 = 3, iE1 = 4, iB2 = 5, iE2 = 6, iX = 7, iY = 8;

/** newtonSolve 的每样本上下文(伴随模型端口参数;DC 时电导/历史按开路处理) */
interface SolveCtx {
  /** 输入端口:iCin = iInConst - gIn·vB0(流入 vB0) */
  iInConst: number;
  gIn: number;
  /** C1+R1 耦合支路:iCpl = gCpl·(vE0-vB1) + iCplH(vE0 → vB1) */
  gCpl: number;
  iCplH: number;
  /** C2 伴随:iC2 = gC2·(vE2-vX) + iC2h(vE2 → vX) */
  gC2: number;
  iC2h: number;
  /** C3 伴随:iC3 = gC3·vY + iC3h(vY → 地) */
  gC3: number;
  iC3h: number;
  /** 电感支路:iL = gL·(vX-vY) + iLh(vX → vY;DC 时 gL=1/60, iLh=0) */
  gL: number;
  iLh: number;
  maxIter: number;
}

interface SolveOut {
  u: number[];
  rMax: number;
  iters: number;
}

export class CrybabyStage {
  private readonly T: number;
  private readonly Vcc: number;
  private readonly Rs: number;
  private readonly Is: number;
  private readonly BF: number;
  private readonly BR: number;
  private readonly Vt: number;

  // 元件电导(常量)
  private readonly gRb0a = 1 / 2.2e6; // 缓冲基极偏置上臂 →Vcc
  private readonly gRb0b = 1 / 1.8e6; // 缓冲基极偏置下臂 →地
  private readonly gRe0 = 1 / 10e3;
  private readonly R1 = 68e3;         // C1 耦合支路串联电阻
  private readonly gR6 = 1 / 1.5e3;
  private readonly gR5 = 1 / 22e3;
  private readonly gR4 = 1 / 390;
  private readonly gR2 = 1 / 470e3;
  private readonly gR3 = 1 / 82e3;
  private readonly gR8 = 1 / 470e3;
  private readonly gR9 = 1 / 10e3;
  private readonly gR7 = 1 / 33e3;

  // 储能元件伴随参数
  private readonly GcIn: number;  // Cin 0.01uF
  private readonly Gc1: number;   // C1  0.01uF(级间耦合)
  private readonly c1Denom: number; // 1+R1·Gc1
  private readonly Gc2: number;   // C2  0.01uF
  private readonly Gc3: number;   // C3  4.7uF
  private readonly Gl: number;    // L1 500mH
  private readonly Rdcr = 60;     // 电感绕线直流电阻
  private readonly gLTran: number;   // 瞬态支路电导 Gl/(1+Rdcr·Gl)
  private readonly lDenom: number;   // 1+Rdcr·Gl

  // 踏板电位器电导(setPosition 可变)
  private gTop = 1 / 50e3;
  private gBot = 1 / 50e3;

  // 电容状态(上一采样)
  private vCinPrev = 0;
  private iCinPrev = 0;
  private vCplPrev = 0;
  private iCplPrev = 0;
  private vC2Prev = 0;
  private iC2Prev = 0;
  private vC3Prev = 0;
  private iC3Prev = 0;
  // 电感伴随历史(上一采样)
  private lIhPrev = 0;

  // 输出 DC blocker 状态
  private readonly blkR: number;
  private blkX = 0;
  private blkY = 0;

  /** Newton 初值:固定初始猜测(solveDC 从这里出发, watchdog 复位也用它,保证确定性) */
  private static readonly INIT_U = [3.1, 2.4, 0.7, 4.5, 0.07, 2.4, 1.8, 0.7, 0.69];
  /** Newton 初值沿用上一采样(初始为 DC 工作点,由 solveDC 填入) */
  private u: number[] = [...CrybabyStage.INIT_U];
  private vinPrev = 0;
  private voutPrev = 0;

  /** 求解器统计(评测用) */
  iterTotal = 0;
  iterCount = 0;
  /** 未收敛回退次数(应为 0 或极少) */
  nonConverged = 0;

  constructor(opts: CrybabyOptions) {
    this.T = 1 / opts.fs;
    this.Vcc = opts.Vcc ?? 9;
    this.Rs = opts.Rs ?? 0;
    this.Is = opts.Is ?? 2e-14;
    this.BF = opts.BF ?? 250;
    this.BR = opts.BR ?? 1;
    this.Vt = opts.Vt ?? 26e-3;
    this.GcIn = (2 * 0.01e-6) / this.T;
    this.Gc1 = (2 * 0.01e-6) / this.T;
    this.c1Denom = 1 + this.R1 * this.Gc1;
    this.Gc2 = (2 * 0.01e-6) / this.T;
    this.Gc3 = (2 * 4.7e-6) / this.T;
    this.Gl = this.T / (2 * 0.5);
    this.lDenom = 1 + this.Rdcr * this.Gl;
    this.gLTran = this.Gl / this.lDenom;
    this.blkR = Math.exp((-2 * Math.PI * DC_BLOCK_HZ) * this.T);
    this.solveDC();
  }

  /** 踏板位置 0(跟位/低频)~1(顶位/高频);钳到 [0.02,0.98] 防止零电阻 */
  setPosition(w: number): void {
    const p = Math.min(0.98, Math.max(0.02, w));
    this.gTop = 1 / (p * 100e3);
    this.gBot = 1 / ((1 - p) * 100e3);
  }

  /** 当前节点电压(评测用;构造时 solveDC 求得 DC 工作点) */
  get nodeVoltages(): readonly number[] {
    return this.u;
  }

  private expArg(v: number): number {
    const x = v / this.Vt;
    return x > EXP_MAX ? Math.exp(EXP_MAX) : x < -EXP_MAX ? 0 : Math.exp(x);
  }

  /**
   * 9 变量阻尼 Newton:解全节点 KCL,精确解析 Jacobian。
   * 不触碰状态;从 start 出发,返回解与收敛残差。DC/瞬态/延拓子步共用。
   */
  private newtonSolve(ctx: SolveCtx, start: number[]): SolveOut {
    const { Is, BF, BR, Vt, Vcc } = this;
    const iBR = 1 + 1 / BR;
    const u = start.slice();
    const F = new Array<number>(N);
    const J = new Array<number>(N * N);

    // 残差评估:返回各 BJT 的结电压指数(Jacobian 复用)
    const evalRes = () => {
      const vB0 = u[iB0], vE0 = u[iE0], vB1 = u[iB1], vC1 = u[iC1], vE1 = u[iE1];
      const vB2 = u[iB2], vE2 = u[iE2], vX = u[iX], vY = u[iY];
      const eBe0 = this.expArg(vB0 - vE0);
      const eBc0 = this.expArg(vB0 - Vcc); // QB 集电极直连 Vcc
      const eBe1 = this.expArg(vB1 - vE1);
      const eBc1 = this.expArg(vB1 - vC1);
      const eBe2 = this.expArg(vB2 - vE2);
      const eBc2 = this.expArg(vB2 - Vcc); // Q2 集电极直连 Vcc

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

      // 各节点 KCL(流出 = 0)
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

    // 解析 Jacobian(与 evalRes 的求导一一对应)
    const buildJ = (e: { eBe0: number; eBc0: number; eBe1: number; eBc1: number; eBe2: number; eBc2: number }) => {
      J.fill(0);
      const s = Is / Vt;
      const gBe0 = s * e.eBe0, gBc0 = s * e.eBc0;
      const gBe1 = s * e.eBe1, gBc1 = s * e.eBc1;
      const gBe2 = s * e.eBe2, gBc2 = s * e.eBc2;
      // vB0 行
      J[iB0 * N + iB0] = this.gRb0a + this.gRb0b + gBe0 / BF + gBc0 / BR + ctx.gIn;
      J[iB0 * N + iE0] = -gBe0 / BF;
      // vE0 行
      J[iE0 * N + iB0] = -(gBe0 * (1 + 1 / BF) + gBc0);
      J[iE0 * N + iE0] = this.gRe0 + ctx.gCpl + gBe0 * (1 + 1 / BF);
      J[iE0 * N + iB1] = -ctx.gCpl;
      // vB1 行
      J[iB1 * N + iE0] = -ctx.gCpl;
      J[iB1 * N + iB1] = ctx.gCpl + this.gR6 + gBe1 / BF + gBc1 / BR;
      J[iB1 * N + iC1] = -gBc1 / BR;
      J[iB1 * N + iE1] = -gBe1 / BF;
      J[iB1 * N + iX] = -this.gR6;
      // vC1 行
      J[iC1 * N + iB1] = gBe1 - gBc1 * iBR;
      J[iC1 * N + iC1] = this.gR5 + this.gR2 + this.gR8 + this.gTop + gBc1 * iBR;
      J[iC1 * N + iE1] = -gBe1;
      J[iC1 * N + iB2] = -(this.gR8 + this.gTop);
      J[iC1 * N + iY] = -this.gR2;
      // vE1 行
      J[iE1 * N + iB1] = -(gBe1 * (1 + 1 / BF) + gBc1);
      J[iE1 * N + iC1] = gBc1;
      J[iE1 * N + iE1] = this.gR4 + gBe1 * (1 + 1 / BF);
      // vB2 行
      J[iB2 * N + iC1] = -(this.gR8 + this.gTop);
      J[iB2 * N + iB2] = this.gR8 + this.gTop + this.gBot + gBe2 / BF + gBc2 / BR;
      J[iB2 * N + iE2] = -gBe2 / BF;
      // vE2 行
      J[iE2 * N + iB2] = -(gBe2 * (1 + 1 / BF) + gBc2);
      J[iE2 * N + iE2] = this.gR9 + ctx.gC2 + gBe2 * (1 + 1 / BF);
      J[iE2 * N + iX] = -ctx.gC2;
      // vX 行
      J[iX * N + iB1] = -this.gR6;
      J[iX * N + iE2] = -ctx.gC2;
      J[iX * N + iX] = this.gR6 + ctx.gC2 + ctx.gL + this.gR7;
      J[iX * N + iY] = -(ctx.gL + this.gR7);
      // vY 行
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
      // Newton 解 J·dx = -F(solveN 就地破坏 J/F;F 由 evalRes 每轮重填)
      for (let i = 0; i < N; i++) F[i] = -F[i];
      const dx = solveN(J, F, N);
      if (!dx) break;
      // 非有限步长(残差含 Inf 时):判失败,交由延拓/冻结处理
      let dxBad = false;
      for (let i = 0; i < N; i++) {
        if (!Number.isFinite(dx[i])) {
          dxBad = true;
          break;
        }
      }
      if (dxBad) break;
      // 结电压限步(同 fuzzface:≤STEP_MAX 全 Newton 步,超限阻尼 0.5)
      let full = true;
      for (let i = 0; i < N; i++) if (Math.abs(dx[i]) > STEP_MAX) { full = false; break; }
      const damp = full ? 1 : 0.5;
      for (let i = 0; i < N; i++) {
        let d = dx[i] * damp;
        if (d > STEP_MAX) d = STEP_MAX; else if (d < -STEP_MAX) d = -STEP_MAX;
        u[i] += d;
        // 物理盒约束 ±12V,NaN 安全(NaN 落到下界;耦合电容可把节点拉到电源轨外,留裕量)
        if (!(u[i] > -12)) u[i] = -12; else if (!(u[i] < 12)) u[i] = 12;
      }
      exps = evalRes();
      rMax = 0;
      for (let i = 0; i < N; i++) rMax = Math.max(rMax, Math.abs(F[i]));
    }
    return { u, rMax, iters: iter };
  }

  /**
   * DC 工作点求解(电容开路、电感=60Ω DCR,输入 0):同 ngspice 先 OP 后 tran。
   * 解出偏置后一致初始化所有储能元件状态,消除零启动充电瞬态。
   */
  private solveDC(): void {
    // 永远从固定初始猜测出发:watchdog 复位时不受被污染状态影响
    const s = this.newtonSolve(
      { iInConst: 0, gIn: 0, gCpl: 0, iCplH: 0, gC2: 0, iC2h: 0, gC3: 0, iC3h: 0, gL: 1 / this.Rdcr, iLh: 0, maxIter: 200 },
      [...CrybabyStage.INIT_U],
    );
    this.u = s.u;
    const vB0 = this.u[iB0], vE0 = this.u[iE0], vB1 = this.u[iB1], vC1 = this.u[iC1];
    const vE2 = this.u[iE2], vX = this.u[iX], vY = this.u[iY];
    // 电容稳态电压(companion 电流恒 0)
    this.vCinPrev = -vB0; // Cin 左端为源 DC=0
    this.iCinPrev = 0;
    this.vCplPrev = vE0 - vB1; // C1(串联 R1,DC 电流 0)
    this.iCplPrev = 0;
    this.vC2Prev = vE2 - vX;
    this.iC2Prev = 0;
    this.vC3Prev = vY;
    this.iC3Prev = 0;
    // 电感:DC 稳态 vL=0(DCR 承担全部 vXY),Ih = iL = vXY/Rdcr
    this.lIhPrev = (vX - vY) / this.Rdcr;
    // DC blocker:输入恒为 vC1,输出恒 0
    this.blkX = vC1;
    this.blkY = 0;
    this.vinPrev = 0;
    this.voutPrev = 0;
  }

  /**
   * 处理一个样本。vin 为源电压(V,吉他电平),
   * 返回 vC1 经 DC blocker 后的输出电压(V)。
   */
  process(vin: number): number {
    // 非有限输入(NaN/±Inf,可能来自上游效果器):不触碰任何状态,输出上一采样
    if (!Number.isFinite(vin)) {
      this.nonConverged++;
      return this.voutPrev;
    }
    // 步骤开始:由上一状态推出各储能元件历史电流
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

    // 数值延拓(continuation):沿 vin 斜坡分 K 个子步求解(同 fuzzFaceStage),
    // 未收敛则 K 翻倍;末级对输入步长限摆,避免永久性冻结。
    let s: SolveOut | null = null;
    let totalIters = 0;
    let vinUsed = vin;
    const ladder: [number, number][] = [[1, 0], [2, 0], [4, 0], [8, 0], [16, 0], [16, 1.0], [16, 0.5]];
    for (const [kMax, slew] of ladder) {
      vinUsed =
        slew > 0
          ? this.vinPrev + Math.min(slew, Math.max(-slew, vin - this.vinPrev))
          : vin;
      let u = this.u;
      let failed = false;
      totalIters = 0;
      for (let j = 1; j <= kMax; j++) {
        const vj = this.vinPrev + (vinUsed - this.vinPrev) * (j / kMax);
        const r = this.newtonSolve(
          { ...baseCtx, iInConst: gInEff * vj + ihIn / inDenom, maxIter: MAX_ITER },
          u,
        );
        totalIters += r.iters;
        // 严格判据:只有 rMax < TOL 才算收敛(NaN 残差一律判失败,走下一级延拓)
        if (r.rMax < TOL) {
          u = r.u;
        } else {
          failed = true;
          break;
        }
      }
      if (!failed) {
        s = { u, rMax: 0, iters: totalIters };
        break;
      }
    }
    this.iterTotal += totalIters;
    this.iterCount++;
    if (!s) {
      // 全部兜底仍未收敛:冻结状态输出上一采样(防爆音/发散),仅统计
      this.nonConverged++;
      this.vinPrev += Math.min(0.5, Math.max(-0.5, vin - this.vinPrev));
      return this.voutPrev;
    }
    this.vinPrev = vinUsed;
    this.u = s.u;
    const vB0 = this.u[iB0], vE0 = this.u[iE0], vB1 = this.u[iB1], vC1 = this.u[iC1];
    const vE2 = this.u[iE2], vX = this.u[iX], vY = this.u[iY];

    // --- 状态更新(用实际求解的 vinUsed,限摆兜底时保持电容状态一致) ---
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
    // 电感:支路电流 → 扣 DCR 得纯电感电压,更新 Ih = i + Gl·vL
    const vXY = vX - vY;
    const iL = this.gLTran * vXY + baseCtx.iLh;
    const vL = vXY - iL * this.Rdcr;
    this.lIhPrev = iL + this.Gl * vL;

    // 输出:vC1 经一阶 DC blocker(去直流,15Hz 转角不影响 wah 通带)
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

/** NxN 线性方程组(部分主元高斯消元,A/b 就地破坏);奇异时返回 null */
function solveN(A: number[], b: number[], n: number): number[] | null {
  for (let col = 0; col < n; col++) {
    // 列主元
    let piv = col;
    let pMax = Math.abs(A[col * n + col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(A[r * n + col]);
      if (v > pMax) {
        pMax = v;
        piv = r;
      }
    }
    if (pMax < 1e-30) return null;
    if (piv !== col) {
      for (let c = col; c < n; c++) {
        const t = A[col * n + c];
        A[col * n + c] = A[piv * n + c];
        A[piv * n + c] = t;
      }
      const tb = b[col];
      b[col] = b[piv];
      b[piv] = tb;
    }
    const inv = 1 / A[col * n + col];
    for (let r = col + 1; r < n; r++) {
      const f = A[r * n + col] * inv;
      if (f === 0) continue;
      for (let c = col; c < n; c++) A[r * n + c] -= f * A[col * n + c];
      b[r] -= f * b[col];
    }
  }
  const x = new Array<number>(n);
  for (let r = n - 1; r >= 0; r--) {
    let acc = b[r];
    for (let c = r + 1; c < n; c++) acc -= A[r * n + c] * x[c];
    const d = A[r * n + r];
    if (Math.abs(d) < 1e-30) return null;
    x[r] = acc / d;
  }
  return x;
}
