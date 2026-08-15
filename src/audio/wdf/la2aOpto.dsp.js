/**
 * LA-2A 风格光学压缩 DSP 核——单一来源(ADR-0003)。
 *
 * 白盒依据(Teletronix LA-2A 公开电路与 T4B 光电池实测文献):
 * - 侧链峰值检测,宽软拐点 + 随电平渐变的有效比率,Compress ≈ 3:1,
 *   Limit ≈ 10:1。
 * - T4B = EL 面板 + CdS 光敏电阻,两类陷阱中心:快分量(~50-70ms 恢复)
 *   与"光记忆"慢分量(先随快分量回落一半,余尾 1~2s 缓慢消退)。
 *
 * 链路(每通道一个 La2aOptoComp 实例,dB 域一阶包络,线性系统速率,
 * 无需过采样):
 *   输入 → 侧链(峰值检测 env = peakHold(|x|, 5ms)→ 软拐点静态 GR
 *   → T4B 双支路包络 fast 10/60ms + slow 250ms/1.3s 半深度,取 max)
 *   → 增益级(10^(-grDb/20))→ GAIN 补偿(线性,dB 域由外层转换)→ 输出。
 *
 * 双模式消费:worklet(la2aWorklet.ts)经 `?raw` 取源码字符串拼装 Blob;
 * eval/测试直接 import。只用单行 import 与内联 export
 * (buildProcessorSource 依赖此约定剥离模块语法)。
 * 本文件以原 worklet 内联版为权威逐表达式平移(issue #7,音色零变化);
 * 构造签名取内联版的位置参数 (fs)(旧 core 的 {fs} options 已废弃)。
 */

// T4B 时间常数(实测量级)
const ENV_REL_S = 0.005; // 峰值包络保持(整流后平滑;远快于 T4B,不主导动态)
const ATK_FAST_S = 0.01; // EL 面板发光 + LDR 快响应 ~10ms
const REL_FAST_S = 0.06; // 短瞬态后快释放 ~60ms(目标 50-70ms)
const ATK_SLOW_S = 0.25; // 光记忆充电(短 burst 几乎充不上)
const REL_SLOW_S = 1.3; // 光记忆消退(持续音后 ~1-2s 长尾)
/** 记忆分量稳态深度:决定持续音释放第一段(快)降到约一半后转入慢尾 */
const SLOW_DEPTH = 0.5;
/** 软拐点宽度(dB) */
const KNEE_DB = 15;
const RATIO_COMPRESS = 3;
const RATIO_LIMIT = 10;
/** 包络下限(-180dB),防 log(0) */
const ENV_FLOOR = 1e-9;
const LN10_OVER_20 = Math.log(10) / 20;

/**
 * 单通道 LA-2A 风格光学压缩核心(每样本 process(x) → y)。
 * 逐表达式平移自原 worklet 内联版;采样率由构造注入。
 */
export class La2aOptoComp {
  /** @param {number} fs 采样率 */
  constructor(fs) {
    this.coefEnvRel = Math.exp(-1 / (ENV_REL_S * fs));
    this.coefAtkFast = 1 - Math.exp(-1 / (ATK_FAST_S * fs));
    this.coefRelFast = 1 - Math.exp(-1 / (REL_FAST_S * fs));
    this.coefAtkSlow = 1 - Math.exp(-1 / (ATK_SLOW_S * fs));
    this.coefRelSlow = 1 - Math.exp(-1 / (REL_SLOW_S * fs));
    this.thresholdDb = 2 - 0.42 * 30;
    this.ratio = RATIO_COMPRESS;
    this.makeup = 1;
    this.envLin = 0;
    this.fastDb = 0;
    this.slowDb = 0;
    /** 当前增益缩减量(dB,≥0),评测脚本直接读取 */
    this.grDb = 0;
  }

  /** REDUCTION 0~100 → 阈值 +2 ~ -40dBFS(LA-2A 面板逻辑:拧大 = 压得多) */
  setReduction(r) {
    const rc = Math.min(100, Math.max(0, r));
    this.thresholdDb = 2 - 0.42 * rc;
  }

  /** MODE:0 = Compress(3:1),≥0.5 = Limit(10:1) */
  setMode(mode) {
    this.ratio = mode >= 0.5 ? RATIO_LIMIT : RATIO_COMPRESS;
  }

  /** GAIN 补偿增益(线性,dB 域由外层转换) */
  setMakeupGain(lin) {
    this.makeup = Math.min(40, Math.max(0, lin));
  }

  /** 静态增益缩减(dB):宽软拐点,over 超过膝区后斜率 1-1/R */
  staticGrDb(envDb) {
    const over = envDb - this.thresholdDb;
    const slope = 1 - 1 / this.ratio;
    const halfK = KNEE_DB / 2;
    if (over <= -halfK) return 0;
    if (over >= halfK) return slope * over;
    const t = over + halfK;
    return (slope * t * t) / (2 * KNEE_DB);
  }

  process(x) {
    // 峰值包络:瞬时攻击(峰值响应),5ms 指数释放
    const ax = Math.abs(x);
    this.envLin = ax > this.envLin ? ax : this.envLin * this.coefEnvRel;
    const envDb = Math.log(this.envLin + ENV_FLOOR) / LN10_OVER_20;
    const gr = this.staticGrDb(envDb);
    // 快分量(EL 面板 + LDR 快响应)
    const cF = gr > this.fastDb ? this.coefAtkFast : this.coefRelFast;
    this.fastDb += cF * (gr - this.fastDb);
    // 光记忆分量(半深度,慢充慢放)
    const sTarget = SLOW_DEPTH * gr;
    const cS = sTarget > this.slowDb ? this.coefAtkSlow : this.coefRelSlow;
    this.slowDb += cS * (sTarget - this.slowDb);
    this.grDb = Math.max(this.fastDb, this.slowDb);
    return x * Math.exp(-this.grDb * LN10_OVER_20) * this.makeup;
  }
}

/**
 * LA-2A 全链路引擎。process(inputs, outputs, params) 语义与
 * AudioWorkletProcessor.process 一致;采样率由构造注入(替代 worklet 全局
 * sampleRate),引擎内不含任何 AudioWorklet API。每通道独立 T4B 包络状态。
 */
export class La2aOptoEngine {
  /** @param {number} sampleRate 采样率 */
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    /** @type {La2aOptoComp[]} 每通道独立压缩核 */
    this.chains = [];
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    while (this.chains.length < input.length) {
      this.chains.push(new La2aOptoComp(this.sampleRate));
    }

    const reduction = params.reduction[0];
    const gain = params.gain[0];
    const mode = params.mode[0];

    for (let ch = 0; ch < input.length; ch++) {
      const c = this.chains[ch];
      c.setReduction(reduction);
      c.setMakeupGain(gain);
      c.setMode(mode);
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) out[i] = c.process(inp[i]);
    }
    return true;
  }
}
