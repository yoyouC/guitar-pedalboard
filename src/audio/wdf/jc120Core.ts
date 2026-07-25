/**
 * WDF JC-120(Roland Jazz Chorus 风格,全固态极致清音)DSP 核心。
 *
 * 链路(无电子管,全部线性件用梯形/单极点伴随模型离散):
 *   输入 → 30Hz 输入耦合 HP
 *        → 运放线性增益级:drive = 2 + (GAIN/100)·18(2..20 倍),
 *          电源轨软饱和 15·tanh(v/15)(小信号增益精确 = drive,极端输入才进入软削)
 *        → 固态后级:固定 ×2,深度 tanh 兜底 25·tanh(v/25)(超大动态余量)
 *        → 扬声器带宽:50Hz HP + 8kHz LP(单极点,无输出变压器)
 *        → /NORM 归一化
 *   (基率)可选 CHORUS:0.45Hz 三角波 LFO 调制 5ms±2.5ms 延迟 + 干湿混合
 *
 * 全链非线性均为显式无记忆 tanh(串联、无反馈耦合),不需要隐式 Newton——
 * 显式求值即精确解,这是与三极管级(隐式 Koren 方程)的本质区别。
 *
 * worklet(jc120Worklet.ts)内联同一份 JS,改动请两边同步。
 */

export const JC120 = {
  /** 输入耦合 HP 转角(Hz) */
  HP_IN: 30,
  /** 运放电源轨软饱和电压(V) */
  RAIL_PRE: 15,
  /** 前置增益行程:drive = PRE_MIN + (gain/100)·PRE_SPAN */
  PRE_MIN: 2,
  PRE_SPAN: 18,
  /** 后级固定增益 */
  POWER_GAIN: 2,
  /** 后级深度软削兜底电压(V) */
  RAIL_POWER: 25,
  /** 扬声器 HP/LP 转角(Hz) */
  SPK_HP: 50,
  SPK_LP: 8000,
  /** 输出归一化(内部"电压"→ 数字电平) */
  NORM: 12,
  /** 合唱:三角波 LFO 速率(Hz)、中心延迟(ms)、调制深度(±ms)、湿声比例 */
  CHORUS_RATE: 0.45,
  CHORUS_CENTER_MS: 5,
  CHORUS_DEPTH_MS: 2.5,
  CHORUS_MIX: 0.5,
} as const;

/** GAIN 旋钮(0~100)→ 运放级线性增益倍数 */
export function jc120Drive(gainPct: number): number {
  return JC120.PRE_MIN + (gainPct / 100) * JC120.PRE_SPAN;
}

/**
 * 静态传输核(无滤波器的纯静态曲线,L1 用):
 * v = RAIL_POWER·tanh(POWER_GAIN·RAIL_PRE·tanh(x·drive/RAIL_PRE)/RAIL_POWER)/NORM
 */
export function jc120Nonlin(x: number, drive: number): number {
  const v1 = JC120.RAIL_PRE * Math.tanh((x * drive) / JC120.RAIL_PRE);
  return (JC120.RAIL_POWER * Math.tanh((JC120.POWER_GAIN * v1) / JC120.RAIL_POWER)) / JC120.NORM;
}

/** 单极点 HP(与 champ/bogner worklet 变压器同式) */
function makeHp(fs: number, fc: number) {
  const T = 1 / fs;
  const rc = 1 / (2 * Math.PI * fc);
  const a = rc / (rc + T);
  let x1 = 0, y1 = 0;
  return (x: number) => {
    const y = a * (y1 + x - x1);
    x1 = x;
    y1 = y;
    return y;
  };
}

/** 单极点 LP */
function makeLp(fs: number, fc: number) {
  const T = 1 / fs;
  const rc = 1 / (2 * Math.PI * fc);
  const a = T / (rc + T);
  let y1 = 0;
  return (x: number) => (y1 = y1 + a * (x - y1));
}

/** 清音主链(过采样域,每通道一个实例) */
export class Jc120Core {
  private drive = jc120Drive(40);
  private readonly hpIn: (x: number) => number;
  private readonly spkHp: (x: number) => number;
  private readonly spkLp: (x: number) => number;

  constructor(fs: number) {
    this.hpIn = makeHp(fs, JC120.HP_IN);
    this.spkHp = makeHp(fs, JC120.SPK_HP);
    this.spkLp = makeLp(fs, JC120.SPK_LP);
  }

  setGain(gainPct: number): void {
    this.drive = jc120Drive(gainPct);
  }

  /** 处理一个 OS 域样本,返回归一化输出 */
  processOs(x: number): number {
    const v0 = this.hpIn(x);
    const v1 = JC120.RAIL_PRE * Math.tanh((v0 * this.drive) / JC120.RAIL_PRE);
    const v2 =
      JC120.RAIL_POWER * Math.tanh((JC120.POWER_GAIN * v1) / JC120.RAIL_POWER);
    return this.spkLp(this.spkHp(v2)) / JC120.NORM;
  }
}

/**
 * JC 标志性立体声合唱(基率,每通道一个实例):
 * 0.45Hz 三角波 LFO 调制 5ms±2.5ms 延迟,干湿 50/50 混合;
 * 通道间 LFO 相位错开(立体声宽度),phase0 由调用方按通道号给。
 * CHORUS 为开关参数(0/1),mix 平滑过渡防爆音;off 时输出精确等于干声。
 */
export class Jc120Chorus {
  private readonly fs: number;
  private readonly buf: Float32Array;
  private readonly mask: number;
  private w = 0;
  private phase: number; // 0..1
  private target = 0;
  private mix = 0;

  constructor(fs: number, phase0 = 0) {
    this.fs = fs;
    let len = 1;
    while (len < fs * 0.02) len <<= 1; // ≥20ms,2 的幂
    this.buf = new Float32Array(len);
    this.mask = len - 1;
    this.phase = phase0 - Math.floor(phase0);
  }

  /** 0/1 开关 */
  setOn(on: number): void {
    this.target = on > 0.5 ? JC120.CHORUS_MIX : 0;
  }

  /** 三角波 LFO:phase∈[0,1) → [-1,1] */
  private tri(): number {
    return this.phase < 0.5 ? 4 * this.phase - 1 : 3 - 4 * this.phase;
  }

  process(x: number): number {
    if (this.mix < 1e-6 && this.target === 0) {
      this.w = (this.w + 1) & this.mask;
      this.buf[this.w] = x;
      this.phase += JC120.CHORUS_RATE / this.fs;
      if (this.phase >= 1) this.phase -= 1;
      return x;
    }
    this.w = (this.w + 1) & this.mask;
    this.buf[this.w] = x;
    const dMs = JC120.CHORUS_CENTER_MS + JC120.CHORUS_DEPTH_MS * this.tri();
    const d = (dMs / 1000) * this.fs;
    const r = this.w - d;
    const i0 = Math.floor(r);
    const frac = r - i0;
    const a = this.buf[i0 & this.mask];
    const wet = a + (this.buf[(i0 + 1) & this.mask] - a) * frac;
    this.phase += JC120.CHORUS_RATE / this.fs;
    if (this.phase >= 1) this.phase -= 1;
    this.mix += 0.002 * (this.target - this.mix);
    return x * (1 - this.mix) + wet * this.mix;
  }
}
