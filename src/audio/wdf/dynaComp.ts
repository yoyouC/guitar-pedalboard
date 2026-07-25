/**
 * MXR Dyna Comp 风格 OTA 压缩核心(纯 TS,Node 可测,无 AudioContext 依赖)。
 *
 * 电路参考(ElectroSmash MXR Dyna Comp 分析):
 *   - CA3080 OTA 作压控增益级:跨导 gm ∝ Iabc(5 脚偏置电流),
 *     输入经大分压垫整,OTA 工作在线性区 → 建模为线性 VCA(非线性可忽略,
 *     故无需过采样,直接用 sampleRate);
 *   - 侧链为**反馈拓扑**:包络检波取自 OTA 输出,峰值检波 + RC 充放电;
 *   - 包络驱动控制管"偷走"Iabc,VBE 指数律 ⇒ 增益衰减(dB)≈ 线性于包络(dB);
 *   - 启动/释放时间由 RC 固定(Dyna Comp 无 Attack/Release 旋钮)。
 *
 * 离散模型(每样本):
 *   y  = g·x                              // OTA VCA(线性乘法器)
 *   e  = 20·log10(max(|y|, 1e-7))         // 反馈峰值包络(dB,瞬时)
 *   t  = kFb·max(0, e − thr)              // 目标增益衰减(dB),thr 由 SENSITIVITY 反比设定
 *   GR = GR + c·(t − GR), c = cAtt(t>GR)/cRel(t≤GR)   // RC 充放电(一阶,作用于 dB 域)
 *   g  = 10^(−GR/20)
 *
 * 反馈环稳态:GR = kFb·(inDb − thr − GR) ⇒ outDb = (inDb + kFb·thr)/(1 + kFb),
 * 静态压缩比 = 1 + kFb = 11:1(kFb = 10)。
 * 启动滞后 ⇒ 瞬态先以全增益冲出再被压下 —— 标志性"泵感"起音;
 * 低音音符上 GR 随 |y| 波动 ⇒ OTA 压缩特有的低频呼吸感。
 */

export interface DynaCompOptions {
  /** 采样率(时序类线性系统,无需过采样) */
  fs: number;
  /** 启动时间常数 ms,默认 2(固定,实测 t90 ≈ 5ms) */
  attackMs?: number;
  /** 释放时间常数 ms,默认 250(实测 t63 ≈ 250ms) */
  releaseMs?: number;
  /** 反馈环增益 kFb,静态压缩比 = 1 + kFb,默认 10(→ 11:1) */
  fbGain?: number;
}

/** SENSITIVITY → 阈值:thr = THR_MAX − THR_SPAN·s(灵敏度 = 阈值反比) */
const THR_MAX_DB = -10; // s=0:仅最响的信号触发
const THR_SPAN_DB = 45; // s=1:-55dB,弱信号也深度压缩
/** 包络下限,防 log10(0) */
const ENV_FLOOR = 1e-7;

export class DynaCompCore {
  private readonly cAtt: number;
  private readonly cRel: number;
  private readonly kFb: number;

  /** 阈值(dBFS 峰值域),setSensitivity 设置 */
  private thrDb = THR_MAX_DB - THR_SPAN_DB * 0.5;

  /** 当前增益衰减(dB,≥0)与对应线性增益——评测脚本据此测量动态 */
  grDb = 0;
  gain = 1;

  constructor(opts: DynaCompOptions) {
    const fs = opts.fs;
    const tAtt = (opts.attackMs ?? 2) / 1000;
    const tRel = (opts.releaseMs ?? 250) / 1000;
    this.cAtt = 1 - Math.exp(-1 / (tAtt * fs));
    this.cRel = 1 - Math.exp(-1 / (tRel * fs));
    this.kFb = opts.fbGain ?? 10;
  }

  /** sensitivity 0~1 → 阈值 −10 ~ −55dB(灵敏度 = 阈值反比) */
  setSensitivity(s: number): void {
    const sc = Math.min(1, Math.max(0, s));
    this.thrDb = THR_MAX_DB - THR_SPAN_DB * sc;
  }

  process(x: number): number {
    // 1) OTA VCA(用上一样本的增益,反馈环单位延迟保证因果稳定)
    const y = this.gain * x;

    // 2) 反馈峰值包络(dB)
    const inst = Math.abs(y);
    const envDb = 20 * Math.log10(inst > ENV_FLOOR ? inst : ENV_FLOOR);

    // 3) 目标衰减 + RC 一阶平滑(dB 域:充电快=启动,放电慢=释放)
    const over = envDb - this.thrDb;
    const target = over > 0 ? this.kFb * over : 0;
    const c = target > this.grDb ? this.cAtt : this.cRel;
    this.grDb += c * (target - this.grDb);
    if (this.grDb < 1e-9 && target === 0) this.grDb = 0; // 防 denormal 爬行
    this.gain = Math.pow(10, -this.grDb / 20);

    return y;
  }
}
