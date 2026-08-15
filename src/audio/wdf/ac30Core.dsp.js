/**
 * WDF AC30(Vox Top Boost 风格,英伦 chime 清音/边缘破音)DSP 核——单一来源(ADR-0003)。
 *
 * 链路(全部非线性级为 Koren 三极管隐式 Newton,线性件梯形/单极点伴随):
 *   输入 → 60Hz 输入耦合 HP → drive(GAIN,幂律行程,低档位清音余量)
 *        → 级1 12AX7 暖偏置(Rk 1.5k + 22µF 全旁路,对称、线性区宽)
 *        → ×A1 → 级2 12AX7 冷一点(Rk 2.7k + 0.68µF 部分旁路,中高频前倾)
 *        → ×A2 → 阴极跟随器(12AX7,Rk 100k,增益≈0.99,过载时不对称软压)
 *        → top-boost 音色(BASS 低频搁架 + MID 峰 + TREBLE 高频搁架 + PRESENCE,
 *          50=平直;搁架之间中频自然突出)——音色在后级之前,推音色会改变破音点
 *        → ×A3 → EL84 后级(A 类热偏置,Koren 近似 mu=19 kp=60 kvb=500,
 *          正半周栅流钳位 sag、负半周宽余量 → 偶次为主的音乐性压缩)
 *        → 输出变压器(75Hz HP + 5.5kHz LP + 2.5kHz 临场峰 chime)
 *        → /NORM 归一化
 *   内部 4x 过采样(resample.dsp.js)。每通道独立链路状态。
 *
 * 全部 Koren 级用 triode.dsp.js 的 WdfTriodeStage(二分法栅流钳位 + plateVp
 * KCL 变体,分叉原因见该类注释);阴极跟随器见下方 CathodeFollower。
 *
 * 双模式消费:worklet 经 `?raw` 取源码字符串拼装 Blob;eval/测试直接 import。
 * 只用单行 import 与内联 export(buildProcessorSource 依赖此约定剥离)。
 * 权威来源(issue #7):CathodeFollower/Biquad/链路常数以原 ac30Worklet.ts
 * 内联版为准逐表达式平移(审计:旧 ac30Core.ts 与内联算法逐行同构;core 的
 * gridClamp 开关内联没有、无 eval 使用,已删除;iterTotal/iterCount 为
 * wdf-ac30-eval L0 保留,纯计数不影响数值)。
 * 默认参数漂移(审计例外,待维护者裁定):Ac30Chain 构造默认 gain=35/音色全 50
 * (沿用旧 core 签名,eval 连续性);发声路径默认值由 wrapper 的
 * parameterDescriptors 决定(gain 30、bass 50、mid 55、treble 60、presence 55)。
 */
import { WdfTriodeStage, KOREN_12AX7, korenPlateCurrent } from './triode.dsp.js';
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from './resample.dsp.js';

/**
 * EL84 功率管的近似 Koren 参数(经验拟合,介于 12AX7 与 EL34 之间取):
 * mu≈19(五极管接法三极管化等效)、kp≈60、kvb≈500;kg 按 B+=310V / Rp 4k /
 * Rk 150 静态 ~35mA(A 类热偏置)标定(见 scripts/wdf-ac30-eval.ts L1 打印)。
 */
export const KOREN_EL84_APPROX = { mu: 19, ex: 1.35, kg: 210, kp: 60, kvb: 500 };

/** 链路网关常数(调参冻结) */
export const AC30 = {
  /** 输入耦合 HP 转角(Hz) */
  HP_IN: 60,
  /** GAIN 行程:drive = 1 + DRIVE_MAX·(gain/100)^DRIVE_EXP(幂律:低档清音、高档快进破音) */
  DRIVE_MAX: 18,
  DRIVE_EXP: 1.8,
  /** 级间衰减:级1→级2 / 级2→CF / 音色→EL84(含 top-boost 插入损耗) */
  A1: 0.025,
  A2: 0.075,
  A3: 0.8197,
  /** 输出变压器:HP / LP / 临场峰(频率、Q、叠加量) */
  XF_HP: 75,
  XF_LP: 5500,
  CHIME_F: 2500,
  CHIME_Q: 1,
  CHIME_G: 0.45,
  /** 输出归一化(内部"电压"→ 数字电平;满激励峰值 ≈0.6,清音区增益 ≈1) */
  NORM: 100,
  /** top-boost 音色:BASS/MID/TREBLE ±12dB、PRESENCE ±8dB,50=平直 */
  BASS_F: 110,
  MID_F: 800,
  MID_Q: 1,
  TREBLE_F: 3000,
  PRES_F: 5000,
  TONE_DB: 12,
  PRES_DB: 8,
  SHELF_Q: 0.7071,
};

/** GAIN 旋钮(0~100)→ 前级激励倍数 */
export function ac30Drive(gainPct) {
  const g = Math.min(100, Math.max(0, gainPct)) / 100;
  return 1 + AC30.DRIVE_MAX * Math.pow(g, AC30.DRIVE_EXP);
}

/** 音色旋钮(0~100,50=平直)→ dB */
export function ac30ToneDb(v, range) {
  return ((Math.min(100, Math.max(0, v)) - 50) / 50) * range;
}

/**
 * 阴极跟随器(cathode follower):板极直连 B+,输出取自阴极。
 * 与 TriodeStage 同宗的隐式求解(单变量 F(Ip)=0)+ 隐式栅流钳位,
 * 但阴极无旁路电容、Rk 很大(100k):增益≈0.99、低输出阻抗;
 * 负向余量小(静态 vk 仅几 V),过载时 cutoff 侧先压 → 不对称软压(top-boost 签名之一)。
 * 栅漏 +gridBias 直流偏置抬静态 vk(真实 top-boost 的 CF 栅漏接高电位),
 * 常规激励下近似透明缓冲;破音主角让给 EL84。
 * 外层 Ip 用持久括号二分(F 严格单调)+ Newton 抛光(消除量化格跳变本底)。
 *
 * CathodeFollower 选项
 * @typedef {object} CathodeFollowerOptions
 * @property {number} [Bplus] 电源电压,默认 300V
 * @property {number} [Rk]    阴极电阻,默认 100k
 * @property {number} [Co]    输出耦合电容 F,默认 4.7nF
 * @property {number} [Rload] 输出负载,默认 1M
 * @property {object} [koren] Koren 参数,默认 12AX7
 * @property {number} [Rs]    栅极驱动源内阻,默认 68k
 * @property {number} [gridBias] 栅极直流偏置参考(V,默认 0 = 栅漏接地)
 */
export class CathodeFollower {
  /**
   * @param {number} fs 采样率(含过采样倍率后的实际速率)
   * @param {CathodeFollowerOptions} [opts]
   */
  constructor(fs, opts = {}) {
    this.T = 1 / fs;
    this.Bplus = opts.Bplus ?? 300;
    this.Rk = opts.Rk ?? 100e3;
    this.Co = opts.Co ?? 4.7e-9;
    this.Rload = opts.Rload ?? 1e6;
    this.koren = opts.koren ?? KOREN_12AX7;
    this.Rs = opts.Rs ?? 68e3;
    this.gridBias = opts.gridBias ?? 0;
    this.Rkk = 1 / (1 / this.Rk + 1 / this.Rload); // Rk ∥ Rload(阴极交流负载)
    // 初始猜测:静态阴极电流 ≈ (偏置+几 V)/Rk
    this.ipPrev = Math.max(4e-5, this.gridBias / this.Rk);
    this.vcOut = 0;
    this.iOutPrev = 0;
    this.vgSrc = 0;
    /** 迭代统计(L0 用,纯计数) */
    this.iterTotal = 0;
    this.iterCount = 0;
  }

  /**
   * 阴极电压(含耦合负载的 KCL):ip = vk/Rk + (vk−vc)/Rload
   * → vk = (ip + vc/Rload)·(Rk∥Rload);vc 为耦合电容电压(状态)。
   * DC 稳态自洽:vc=vk → vk = ip·Rk(直流工作点不变)。
   */
  cathodeVk(ip) {
    return (ip + this.vcOut / this.Rload) * this.Rkk;
  }

  /**
   * 二分法隐式栅流钳位(无状态延迟):解单调方程
   * g(vg) = vg − vgSrc + Rs·ig(vg−vk) = 0。CF 栅漏接 +60V 偏置,vgSrc−vk
   * 恒正且很大,阻尼定点会被 Rs·ig(指数封顶后仍达 ~0.5A·Rs ≈ 数万 V)
   * 一脚踹到 −16kV,Koren 板流归零、ip 锁死在 0(链中曾复现:CF 输出恒 0)。
   * g(vk) ≤ 0 ≤ g(vgSrc) 必有根,二分全局收敛、不 overshoot。
   */
  solveGrid(vgSrc, vk) {
    if (vgSrc <= vk) return vgSrc;
    let lo = vk, hi = vgSrc;
    for (let gi = 0; gi < 14; gi++) {
      const mid = 0.5 * (lo + hi);
      const x = Math.min((mid - vk) / 0.0414, 20);
      const ig = 1e-9 * (Math.exp(x) - 1);
      const g = mid - vgSrc + this.Rs * ig;
      if (g > 0) hi = mid;
      else lo = mid;
    }
    return 0.5 * (lo + hi);
  }

  /** F(Ip) = Ip − koren(vg−vk, B+−vk),vk 由 cathodeVk(含负载);栅源 = 信号 + 直流偏置 */
  residual(ip) {
    const vk = this.cathodeVk(ip);
    const vg = this.solveGrid(this.vgSrc + this.gridBias, vk);
    return ip - korenPlateCurrent(this.koren, vg - vk, this.Bplus - vk);
  }

  /**
   * 外层 Ip 求解:F(ip) 严格单调升(ip 项 +1,koren 随 vk 非增),
   * 用持久括号 + 二分——Rk=100k 使 vk 对 ip 极敏感(Δ1µA→Δ0.1V),
   * 定点 Newton 的步长钳制会在"导通/截止"两盆间来回超调锁死
   * (首样本 +22V 建立瞬态曾复现:ip 在 0 与 1.19mA 间振荡,输出恒 0)。
   * 单调 → 括号 [0, B+/Rk] 内必有根,二分全局收敛;
   * 括号沿用上一样本根附近,常规仅 ~4 次残差求值(比 Newton 还省)。
   */
  process(vgIn) {
    this.vgSrc = vgIn;
    const IP_MAX = this.Bplus / this.Rk;
    // 暖启动紧括号(±2%):CF 电流逐样本漂移 ≪1%,极端摆动由扩展环兜底
    let lo = Math.max(0, this.ipPrev * 0.98 - 1e-9);
    let hi = Math.min(IP_MAX, this.ipPrev * 1.02 + 1e-9);
    this.iterCount++;
    let flo = this.residual(lo);
    let fhi = this.residual(hi);
    // 扩展括号直到夹住变号(信号大幅摆动时)
    for (let g = 0; g < 24 && flo > 0 && lo > 0; g++) {
      hi = lo; fhi = flo; lo *= 0.5;
      this.iterCount++;
      flo = this.residual(lo);
    }
    for (let g = 0; g < 24 && fhi < 0 && hi < IP_MAX; g++) {
      lo = hi; flo = fhi; hi = Math.min(IP_MAX, hi * 2 + 1e-6);
      this.iterCount++;
      fhi = this.residual(hi);
    }
    let ip;
    if (flo >= 0) {
      ip = lo; // F(0) ≥ 0:截止(含 koren=0 时 F(0)=0 的精确不动点)
    } else if (fhi <= 0) {
      ip = hi; // 到物理上限,兜底
    } else {
      for (let it = 0; it < 8; it++) {
        const mid = 0.5 * (lo + hi);
        this.iterCount++;
        this.iterTotal++;
        if (this.residual(mid) > 0) hi = mid;
        else lo = mid;
      }
      ip = 0.5 * (lo + hi);
      // Newton 抛光:二分只到量化格,逐样本会在相邻格间跳变(vk ±0.03V
      // → 静音本底/混叠底噪),抛到机器精度的不动点消除跳变
      for (let p = 0; p < 2; p++) {
        this.iterCount++;
        const f0 = this.residual(ip);
        if (Math.abs(f0) < 1e-13) break;
        const h = Math.max(1e-10, Math.abs(ip) * 1e-6);
        this.iterCount++;
        const df = (this.residual(ip + h) - f0) / h;
        if (df === 0 || !Number.isFinite(df)) break;
        ip -= f0 / df;
        if (ip < 0) ip = 0;
        else if (ip > IP_MAX) ip = IP_MAX;
      }
    }
    this.ipPrev = ip;

    // 阴极电压(含负载 KCL)→ 耦合电容 Co → Rload(梯形精确解)
    const vk = this.cathodeVk(ip);
    const a = this.T / (2 * this.Co);
    const vc = (this.vcOut + a * (vk / this.Rload + this.iOutPrev)) / (1 + a / this.Rload);
    const iOut = (vk - vc) / this.Rload;
    this.vcOut = vc;
    this.iOutPrev = iOut;
    return vk - vc;
  }
}

/** RBJ 双二阶(音色搁架/峰、临场峰带通;0dB 搁架 = 精确直通) */
export class Biquad {
  constructor() {
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
  }
  set(b0, b1, b2, a0, a1, a2) {
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  alpha(fs, f, q) {
    const w0 = (2 * Math.PI * f) / fs;
    return { cs: Math.cos(w0), al: Math.sin(w0) / (2 * q) };
  }
  setLowshelf(fs, f, db, q) {
    const A = Math.pow(10, db / 40);
    const { cs, al } = this.alpha(fs, f, q);
    const sq = 2 * Math.sqrt(A) * al;
    this.set(
      A * (A + 1 - (A - 1) * cs + sq), 2 * A * (A - 1 - (A + 1) * cs), A * (A + 1 - (A - 1) * cs - sq),
      A + 1 + (A - 1) * cs + sq, -2 * (A - 1 + (A + 1) * cs), A + 1 + (A - 1) * cs - sq);
  }
  setHighshelf(fs, f, db, q) {
    const A = Math.pow(10, db / 40);
    const { cs, al } = this.alpha(fs, f, q);
    const sq = 2 * Math.sqrt(A) * al;
    this.set(
      A * (A + 1 + (A - 1) * cs + sq), -2 * A * (A - 1 + (A + 1) * cs), A * (A + 1 + (A - 1) * cs - sq),
      A + 1 - (A - 1) * cs + sq, 2 * (A - 1 - (A + 1) * cs), A + 1 - (A - 1) * cs - sq);
  }
  setPeaking(fs, f, db, q) {
    const A = Math.pow(10, db / 40);
    const { cs, al } = this.alpha(fs, f, q);
    this.set(1 + al * A, -2 * cs, 1 - al * A, 1 + al / A, -2 * cs, 1 - al / A);
  }
  /** 带通(峰值增益恒 0dB,与串联 RLC 取 R 上电压同构)——2.5kHz 临场峰用 */
  setBandpass(fs, f, q) {
    const { cs, al } = this.alpha(fs, f, q);
    this.set(al, 0, -al, 1 + al, -2 * cs, 1 - al);
  }
  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

/**
 * AC30 全链(过采样域,每通道一个实例)。
 * 构造签名沿用旧 core(eval 连续性):增益/音色默认值 35/50/50/50/50;
 * 发声路径的实际默认值由 worklet wrapper 的 parameterDescriptors 决定。
 */
export class Ac30Chain {
  /**
   * @param {number} fs 过采样域采样率
   * @param {number} [gain] GAIN 旋钮 0~100,默认 35
   * @param {number} [bassV] 默认 50(平直)
   * @param {number} [midV] 默认 50
   * @param {number} [trebleV] 默认 50
   * @param {number} [presenceV] 默认 50
   */
  constructor(fs, gain = 35, bassV = 50, midV = 50, trebleV = 50, presenceV = 50) {
    this.fs = fs;
    // 级1:暖偏置(全旁路,对称、线性区宽),Rs 68k 栅漏
    this.st1 = new WdfTriodeStage(fs, { Rk: 1.5e3, Ck: 22e-6, Rs: 68e3 });
    // 级2:冷一点(Rk 2.7k + 0.68µF 部分旁路,中高频前倾),Rs = 级间分压戴维南 24.4k
    this.st2 = new WdfTriodeStage(fs, { Rk: 2.7e3, Ck: 0.68e-6, Rs: 24.4e3 });
    // 阴极跟随器:Rk 100k,栅漏偏置 60V(抬静态 vk → 宽负向余量,近似透明缓冲),
    // Rs = 级间分压戴维南 69.4k,负载 = 220k+1M(EL84 栅路)
    this.cf = new CathodeFollower(fs, { Rk: 100e3, Rs: 69.4e3, Rload: 1.22e6, gridBias: 60 });
    // EL84 后级:A 类,B+ 310V,Rp 4k(反射负载),Rk 150 热偏置,Rs = 栅漏 220k;
    // Rload=100k = 输出变压器初级反射交流负载(spice 侧 Ctx→Rtx 100k;
    // Co 1mF 对其透明,DC 静态点不变)
    this.pw = new WdfTriodeStage(fs, {
      koren: KOREN_EL84_APPROX, Bplus: 310, Rp: 4e3, Rk: 150, Ck: 0,
      Co: 1e-3, Rload: 100e3, Rs: 220e3,
    });
    this.drive = 1;
    // 输入 HP / 变压器 HP+LP 状态
    this.hpIn = { x1: 0, y1: 0 };
    this.xfHp = { x1: 0, y1: 0 };
    this.xfLpY1 = 0;
    this.chime = new Biquad();
    this.bass = new Biquad();
    this.mid = new Biquad();
    this.treble = new Biquad();
    this.presence = new Biquad();
    this.chime.setBandpass(fs, AC30.CHIME_F, AC30.CHIME_Q);
    this.setGain(gain);
    this.setTone(bassV, midV, trebleV, presenceV);
  }

  setGain(gain) {
    this.drive = ac30Drive(gain);
  }

  setTone(bassV, midV, trebleV, presenceV) {
    const fs = this.fs;
    this.bass.setLowshelf(fs, AC30.BASS_F, ac30ToneDb(bassV, AC30.TONE_DB), AC30.SHELF_Q);
    this.mid.setPeaking(fs, AC30.MID_F, ac30ToneDb(midV, AC30.TONE_DB), AC30.MID_Q);
    this.treble.setHighshelf(fs, AC30.TREBLE_F, ac30ToneDb(trebleV, AC30.TONE_DB), AC30.SHELF_Q);
    this.presence.setHighshelf(fs, AC30.PRES_F, ac30ToneDb(presenceV, AC30.PRES_DB), AC30.SHELF_Q);
  }

  hp(st, x, fc) {
    const T = 1 / this.fs;
    const rc = 1 / (2 * Math.PI * fc);
    const a = rc / (rc + T);
    const y = a * (st.y1 + x - st.x1);
    st.x1 = x;
    st.y1 = y;
    return y;
  }

  /** 处理一个过采样域样本,返回归一化输出 */
  process(x0) {
    const x = this.hp(this.hpIn, x0, AC30.HP_IN);
    const s1 = this.st1.process(x * this.drive);
    const s2 = this.st2.process(s1 * AC30.A1);
    const c = this.cf.process(s2 * AC30.A2);
    const t = this.presence.process(this.treble.process(this.mid.process(this.bass.process(c))));
    const p = this.pw.process(t * AC30.A3);
    const h = this.hp(this.xfHp, p, AC30.XF_HP);
    const T = 1 / this.fs;
    const rcLp = 1 / (2 * Math.PI * AC30.XF_LP);
    const aLp = T / (rcLp + T);
    this.xfLpY1 = this.xfLpY1 + aLp * (h - this.xfLpY1);
    // 临场峰:HP 后取带通叠加(与 spice 串联 RLC 支路同构)
    return (this.xfLpY1 + AC30.CHIME_G * this.chime.process(h)) / AC30.NORM;
  }
}

/**
 * AC30 全链路引擎(基率 AudioWorklet 侧):每通道一条 Ac30Chain + 4x 重采样,
 * 音色系数块率更新(lastTone 脏检查,变化 >1e-4 才重算 4 个 Biquad——
 * 50=平直=精确直通)。process(inputs, outputs, params) 语义与
 * AudioWorkletProcessor.process 一致;采样率由构造注入(替代 worklet 全局
 * sampleRate),引擎内不含任何 AudioWorklet API。
 */
export class WdfAc30Engine {
  /** @param {number} sampleRate 基率采样率(引擎内部自行 ×OS_FACTOR) */
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.fir = makeAntiAliasFIR();
    /** @type {object[]} 每通道独立链路状态 */
    this.chains = [];
    this.lastTone = [-1, -1, -1, -1];
  }

  createChain() {
    const fs = this.sampleRate * OS_FACTOR;
    return {
      chain: new Ac30Chain(fs),
      up: new Upsampler4x(this.fir),
      down: new Decimator4x(this.fir),
    };
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    while (this.chains.length < input.length) this.chains.push(this.createChain());

    for (const c of this.chains) c.chain.setGain(params.gain[0]);
    // 音色系数块率更新(50=平直=精确直通)
    const tv = [params.bass[0], params.mid[0], params.treble[0], params.presence[0]];
    if (this.lastTone.some((v, i) => Math.abs(v - tv[i]) > 1e-4)) {
      this.lastTone = tv.slice();
      for (const c of this.chains) c.chain.setTone(tv[0], tv[1], tv[2], tv[3]);
    }

    const osIn = new Float32Array(OS_FACTOR);
    const osOut = new Float32Array(OS_FACTOR);

    for (let ch = 0; ch < input.length; ch++) {
      const c = this.chains[ch];
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) {
        c.up.process(osIn, inp[i]);
        for (let k = 0; k < OS_FACTOR; k++) {
          osOut[k] = c.chain.process(osIn[k]);
        }
        out[i] = c.down.process(osOut[0], osOut[1], osOut[2], osOut[3]);
      }
    }
    return true;
  }
}
