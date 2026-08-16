/**
 * 微光混响(Shimmer Reverb)DSP 核——单一来源(ADR-0003)。
 *
 * 结构(线性时变系统,无非线性,故不需过采样,直接跑 sampleRate):
 *   输入 → 20ms 预延迟 ─────────────────────────────┐
 *        ┌──────────────────────────────────────────┘
 *        │  xin_i = pre + Σ_j H_ij·g_j·fb_j + 0.5·shim
 *        │  4 条反馈延迟线(FDN):out_i → 阻尼 LP(DAMP)→ 30Hz HP(防 DC 堆积)
 *        │  → g_i 反馈,Hadamard×0.5 正交混合;g_i = 10^(-3·d_i/RT60)(TIME)
 *        │  wet = 0.25·(out_0 - out_1 + out_2 - out_3)(交替取号,DC 处相消)
 *        └→ 变调路径:wet → 30Hz HP → 双读头 Hann 窗调制延迟(+1 八度)
 *              shim = s·shift(wetHP) 注入反馈环(0.5/线)并直接混入湿声(0.8)
 *   输出 = cos(θ)·x + sin(θ)·(wet + 0.8·shim),θ = MIX·π/2(等功率交叉淡化)
 *
 * +1 八度原理:读位置 r[n] = w[n] - D[n],D 以 1 样本/样本斜率从 G 降到 0
 * (回绕点 Hann 窗为 0,无爆音),读速 = 1 - dD/dn = 2 倍 → 上移一个八度。
 * 双读头相位错开半个周期,Hann 窗互补相加恒为 1,变调路径增益 ≈ 1。
 *
 * 稳定性:直接环增益 g_i < 1;shimmer 环每圈把能量 ×2 频移(f→2f→4f…),
 * 唯一不动点是 DC,被环内 HP 与交替取号的湿声求和双重扼杀 → 无条件有界。
 *
 * 双模式消费:worklet 经 `?raw` 取源码字符串拼装 Blob;eval/测试直接 import。
 * 只用单行 import 与内联 export(buildProcessorSource 依赖此约定剥离)。
 * 本文件以原 shimmerWorklet.ts 内联版为权威逐表达式平移(构造签名
 * (fs, channel) 位置参数,issue #7)。
 */

/** 4 条 FDN 延迟线长度(48k 基准样本数,互质比例,~31.6~46.1ms) */
const LINE_LENS_48K = [1517, 1747, 1979, 2213];
/** 预延迟(s) */
const PREDELAY_S = 0.02;
/** 变调粒度(s):85ms → 调幅边带 ±11.8Hz,氛围垫可接受 */
const GRAIN_S = 0.085;
/** 环内/变调输入 DC 阻断 HP 截止(Hz) */
const HP_FC = 30;
/** shimmer 注入每条线的权重 */
const SHIM_INJ = 0.5;
/** shimmer 直接混入湿声的权重 */
const SHIM_OUT = 0.8;
/**
 * 环内 LP/HP 在中频带(350~700Hz)的实测附加衰减(dB/s,damp=0 基准)。
 * setTime 预补偿该损耗,使 TIME 标定的 RT60 在 damp=0 时准确;
 * damp>0 的额外衰减是 DAMP 参数本身的职责,不补偿。
 */
const LOOP_FILTER_LOSS_DBPS = 2.1;

/**
 * 微光混响单链(每通道一条)。
 * @param {number} fs 采样率(时序类效果不重采样,直接用 sampleRate)
 * @param {number} channel 声道索引:奇数声道延迟线微偏调 + 变调相位错开,
 *   立体声去相关
 */
export class ShimmerReverb {
  constructor(fs, channel) {
    this.fs = fs;
    // 奇数声道线长 +0.41%,立体声尾部去相关
    const scale = channel % 2 === 1 ? 1.0041 : 1.0;
    this.lines = LINE_LENS_48K.map((len48) => {
      const len = Math.max(16, Math.round((len48 / 48000) * fs * scale));
      return new Float32Array(len);
    });
    this.pos = [0, 0, 0, 0];
    this.g = [0, 0, 0, 0]; // 各线反馈增益(setTime 计算)
    this.lp = [0, 0, 0, 0]; // 阻尼 LP 状态
    this.hp = [0, 0, 0, 0]; // 环内 HP 的 LP 状态
    this.fb = [0, 0, 0, 0];
    this.pdBuf = new Float32Array(Math.max(1, Math.round(PREDELAY_S * fs)));
    this.pdPos = 0;
    this.G = Math.max(64, Math.round(GRAIN_S * fs)); // 粒度(样本)
    this.sBuf = new Float32Array(this.G + 8);
    this.sPos = 0;
    // 奇数声道变调相位错开 0.31 周期
    this.ph0 = channel % 2 === 1 ? 0.31 : 0;
    this.ph1 = (this.ph0 + 0.5) % 1;
    this.shHp = 0; // 变调输入 HP 的 LP 状态
    this.wetPrev = 0;
    const T = 1 / fs;
    this.aHp = T / (1 / (2 * Math.PI * HP_FC) + T);
    this.aDamp = T / (1 / (2 * Math.PI * 10000) + T);
    this.sGain = 0;
    this.dryGain = 1;
    this.wetGain = 0;
    this.setTime(4.5);
    this.setShimmer(40);
    this.setDamp(40);
    this.setMix(35);
  }

  /** time 2~8 s → RT60;g_i = 10^(-3·d_i/RT60) + 环内滤波损耗预补偿 */
  setTime(seconds) {
    const t60 = Math.min(8, Math.max(2, seconds));
    for (let i = 0; i < 4; i++) {
      const d = this.lines[i].length / this.fs;
      this.g[i] = Math.pow(10, (-3 * d) / t60 + (LOOP_FILTER_LOSS_DBPS * d) / 20);
    }
  }

  /** shimmer 0~100 → 变调混入量 0~1 */
  setShimmer(pct) {
    this.sGain = Math.min(100, Math.max(0, pct)) / 100;
  }

  /** damp 0~100 → 环内 LP 截止 10kHz→1kHz(指数) */
  setDamp(pct) {
    const p = Math.min(100, Math.max(0, pct)) / 100;
    const fc = 10000 * Math.pow(0.1, p);
    const T = 1 / this.fs;
    this.aDamp = T / (1 / (2 * Math.PI * fc) + T);
  }

  /** mix 0~100 → 等功率交叉淡化 dry=cos θ, wet=sin θ */
  setMix(pct) {
    const theta = (Math.min(100, Math.max(0, pct)) / 100) * (Math.PI / 2);
    this.dryGain = Math.cos(theta);
    this.wetGain = Math.sin(theta);
  }

  /** +1 八度变调:延迟量以 1 样本/样本斜率下行,读速 2 倍;双读头 Hann 互补窗 */
  shift(x) {
    const L = this.sBuf.length;
    this.sBuf[this.sPos] = x;
    this.sPos = (this.sPos + 1) % L;
    let acc = 0;
    for (let k = 0; k < 2; k++) {
      let ph = k === 0 ? this.ph0 : this.ph1;
      ph += 1 / this.G;
      if (ph >= 1) ph -= 1;
      if (k === 0) this.ph0 = ph;
      else this.ph1 = ph;
      const w = 0.5 * (1 - Math.cos(2 * Math.PI * ph));
      const d = this.G * (1 - ph);
      let rd = this.sPos - 1 - d;
      if (rd < 0) rd += L;
      const i0 = Math.floor(rd);
      const fr = rd - i0;
      const i1 = (i0 + 1) % L;
      acc += w * (this.sBuf[i0] + fr * (this.sBuf[i1] - this.sBuf[i0]));
    }
    return acc;
  }

  process(x) {
    // 预延迟
    const pre = this.pdBuf[this.pdPos];
    this.pdBuf[this.pdPos] = x;
    this.pdPos = (this.pdPos + 1) % this.pdBuf.length;

    // 变调路径:上一样本湿声(隔开一个样本,避免无延迟环路)→ HP → +1 八度
    this.shHp += this.aHp * (this.wetPrev - this.shHp);
    const shim = this.sGain * this.shift(this.wetPrev - this.shHp);

    // 读 4 条线,逐线阻尼 LP + HP,交替取号累湿声
    let wet = 0;
    for (let i = 0; i < 4; i++) {
      const buf = this.lines[i];
      const out = buf[this.pos[i]];
      this.lp[i] += this.aDamp * (out - this.lp[i]);
      this.hp[i] += this.aHp * (this.lp[i] - this.hp[i]);
      this.fb[i] = this.g[i] * (this.lp[i] - this.hp[i]);
      wet += i % 2 === 0 ? out : -out;
    }

    // Hadamard×0.5 正交反馈 + shimmer 注入
    const inj = SHIM_INJ * shim;
    const f0 = this.fb[0], f1 = this.fb[1], f2 = this.fb[2], f3 = this.fb[3];
    const m = [
      0.5 * (f0 + f1 + f2 + f3),
      0.5 * (f0 - f1 + f2 - f3),
      0.5 * (f0 + f1 - f2 - f3),
      0.5 * (f0 - f1 - f2 + f3),
    ];
    for (let i = 0; i < 4; i++) {
      this.lines[i][this.pos[i]] = pre + m[i] + inj;
      this.pos[i] = (this.pos[i] + 1) % this.lines[i].length;
    }

    wet *= 0.25;
    this.wetPrev = wet;
    return this.dryGain * x + this.wetGain * (wet + SHIM_OUT * shim);
  }
}

/**
 * 微光混响全链路引擎。process(inputs, outputs, params) 语义与
 * AudioWorkletProcessor.process 一致;采样率由构造注入(替代 worklet 全局
 * sampleRate),引擎内不含任何 AudioWorklet API。
 * 每通道独立链(声道索引 = 链序号,核内 %2 决定去谐/相位);
 * lastParams 四元组缓存与原内联处理器一致(参数变化才对全链重设)。
 */
export class WdfShimmerEngine {
  /** @param {number} sampleRate 采样率 */
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    /** @type {ShimmerReverb[]} 每通道独立链 */
    this.chains = [];
    /** @type {number[] | null} */
    this.lastParams = null;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    while (this.chains.length < input.length) {
      this.chains.push(new ShimmerReverb(this.sampleRate, this.chains.length));
    }

    const time = params.time[0];
    const shimmer = params.shimmer[0];
    const damp = params.damp[0];
    const mix = params.mix[0];
    const lp = this.lastParams;
    const changed =
      !lp || lp[0] !== time || lp[1] !== shimmer || lp[2] !== damp || lp[3] !== mix;
    if (changed) {
      for (const c of this.chains) {
        c.setTime(time);
        c.setShimmer(shimmer);
        c.setDamp(damp);
        c.setMix(mix);
      }
      this.lastParams = [time, shimmer, damp, mix];
    }

    for (let ch = 0; ch < input.length; ch++) {
      const c = this.chains[ch];
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) out[i] = c.process(inp[i]);
    }
    return true;
  }
}
