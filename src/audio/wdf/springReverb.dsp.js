/**
 * 弹簧混响(Spring Reverb,Fender Twin 弹簧箱风格)DSP 核——单一来源(ADR-0003)。
 *
 * 结构(每通道独立一条链):
 *   输入 → 预限带 LP(8kHz,驱动/拾取换能器带宽)→ 预弥散(2 级串联全通,涂抹瞬态)
 *   → 三条并联"弹簧"环(三弹簧箱,模态更密、包络更平)→ 求和 → 湿声
 *   每条弹簧环(反馈环):
 *     入口 28Hz 一阶 HP(防直流/低频堆积,换能器本来就是带限的)
 *     → 主延迟线(24/31ms,弹簧往返渡越)
 *     → 6 级 Schroeder 短延迟全通(2~6ms 不等,色散 → 金属 "boing" 啁啾)
 *     → 一阶阻尼低通(TONE,直流增益 1 → 每循环一圈高频多衰一点,余音随时间变暗)
 *     → 反馈增益 g(由 TIME 的 RT60 目标反推)→ 回到环入口
 *
 * 反馈增益:g = 10^(-3·T_eff/RT60) / |H_damp(fRef)|
 *   T_eff = 主延迟 + Σ 全通延迟(全通级联的谱平均群延迟恰等于其延迟之和,
 *   与实测衰减周期吻合);|H_damp(fRef)| 补偿阻尼低通在尾部主导频段的
 *   额外损耗(fRef 经实测校准)。
 * 三条弹簧环主延迟/全通延迟取不可通约值,避免单一重复周期(扑翼感);
 * 立体声第二通道整体延迟 ×1.021 去谐(在引擎按通道号给定),获得去相关宽度。
 *
 * 全链路线性(无削波/饱和),按 docs/wdf-whitebox-process.md §1.3 不需要过采样。
 *
 * 双模式消费:worklet 经 `?raw` 取源码字符串拼装 Blob;eval/测试直接 import。
 * 只用单行 import 与内联 export(buildProcessorSource 依赖此约定剥离)。
 * 本文件以原 springreverbWorklet.ts 内联版为权威逐表达式平移(issue #7);
 * 旧 TS core 中未被使用的 OnePoleLP.setFc() 死代码不保留。
 */

// ---- 弹簧物理常数(通道 0 基准,ms)----
/** 弹簧 A:主往返延迟 + 6 级全通色散延迟 */
const MAIN_MS_A = 23.7;
const AP_MS_A = [5.9, 4.4, 3.7, 3.3, 2.5, 2.1];
/** 弹簧 B:与 A 不可通约,抑制单一重复周期 */
const MAIN_MS_B = 31.1;
const AP_MS_B = [5.6, 4.1, 3.4, 3.0, 2.7, 2.2];
/** 弹簧 C:第三条,与 A/B 均不可通约 */
const MAIN_MS_C = 27.3;
const AP_MS_C = [5.2, 4.6, 3.6, 2.9, 2.4, 2.0];
/** 输入预弥散(串联全通,把瞬态涂抹开,消除首反射离散感;换能器惯性的等效) */
const PREDIFF_MS = [4.7, 3.1];
const PREDIFF_GAIN = 0.55;

/** 环内高通(防 DC 堆积) */
const HP_FC = 28;
/** 输入预限带(换能器带宽) */
const PRE_LP_FC = 8000;
/** TONE 阻尼低通行程(Hz,对数映射) */
const TONE_FC_MIN = 1200;
const TONE_FC_MAX = 7000;
/** DWELL → 全通反馈系数行程(色散/啁啾强度) */
const DWELL_AP_MIN = 0.3;
const DWELL_AP_MAX = 0.72;
/** RT60 阻尼补偿参考频率(Hz,尾部能量主导频段,经 wdf-springreverb-eval 实测校准) */
const RT60_REF_HZ = 500;
/** 反馈增益安全上限 */
const G_MAX = 0.97;

/** 整数样本延迟线(环形缓冲) */
class DelayLine {
  constructor(n) {
    this.buf = new Float32Array(Math.max(1, n));
    this.idx = 0;
  }

  process(x) {
    const y = this.buf[this.idx];
    this.buf[this.idx] = x;
    this.idx = (this.idx + 1) % this.buf.length;
    return y;
  }
}

/**
 * Schroeder 短延迟全通:H(z) = (z^-m - a) / (1 - a·z^-m)
 * 单位幅频、直流增益 1;群延迟 τ(ω) = m(1-a²)/(1 - 2a·cos(ωm) + a²),
 * 随频率起伏 → 每循环一圈能量在时间上被"涂抹"(弥散),是 boing 金属感的来源。
 */
class Allpass {
  constructor(n) {
    this.buf = new Float32Array(Math.max(1, n));
    this.idx = 0;
    /** 反馈系数(0~0.72,DWELL 控制) */
    this.a = 0.5;
  }

  process(x) {
    const d = this.buf[this.idx];
    const y = d - this.a * x;
    this.buf[this.idx] = x + this.a * y;
    this.idx = (this.idx + 1) % this.buf.length;
    return y;
  }
}

/** 一阶低通(直流增益 1):H(z) = α / (1 - (1-α)z^-1) */
class OnePoleLP {
  constructor(fc, fs) {
    this.y = 0;
    this.alpha = 1 - Math.exp((-2 * Math.PI * fc) / fs);
  }

  process(x) {
    this.y += this.alpha * (x - this.y);
    return this.y;
  }
}

/** 一阶高通:y[n] = a·(y[n-1] + x[n] - x[n-1]) */
class OnePoleHP {
  constructor(fc, fs) {
    this.xm1 = 0;
    this.ym1 = 0;
    this.a = 1 / (1 + (2 * Math.PI * fc) / fs);
  }

  process(x) {
    const y = this.a * (this.ym1 + x - this.xm1);
    this.xm1 = x;
    this.ym1 = y;
    return y;
  }
}

/** 一阶低通在频率 f 处的幅频响应(用于 RT60 阻尼补偿) */
function onePoleLpMag(alpha, f, fs) {
  const w = (2 * Math.PI * f) / fs;
  const c = Math.cos(w);
  const b = 1 - alpha;
  return alpha / Math.sqrt(1 + b * b - 2 * b * c);
}

/** 一条"弹簧"反馈环 */
class SpringLoop {
  constructor(fs, mainMs, apMs, detune) {
    this.hp = new OnePoleHP(HP_FC, fs);
    /** 主延迟(秒) */
    this.mainSec = (mainMs * detune) / 1000;
    this.main = new DelayLine(Math.round((mainMs * detune * fs) / 1000));
    /** 全通级延迟(秒) */
    this.apSecs = apMs.map((m) => (m * detune) / 1000);
    this.aps = apMs.map((m) => new Allpass(Math.round((m * detune * fs) / 1000)));
    this.damp = new OnePoleLP(2900, fs);
    this.fb = 0;
    /** 反馈增益(recompute 计算) */
    this.g = 0.9;
  }

  /** 有效环长(秒):主延迟 + 各级全通延迟(全通级联的谱平均群延迟 = 延迟之和) */
  effLoopSeconds() {
    let t = this.mainSec;
    for (const m of this.apSecs) t += m;
    return t;
  }

  setApGain(a) {
    for (const ap of this.aps) ap.a = a;
  }

  setDampAlpha(alpha) {
    this.damp.alpha = alpha;
  }

  process(x) {
    let v = this.hp.process(x + this.fb);
    v = this.main.process(v);
    for (const ap of this.aps) v = ap.process(v);
    v = this.damp.process(v);
    this.fb = v * this.g;
    return v;
  }
}

/**
 * 弹簧混响罐(单声道实例;立体声由外层每通道各建一条)。
 * 参数:snap 式设置(平滑由 worklet 侧 setTargetAtTime 完成,评测侧阶跃设置即可)。
 * @param {{fs: number, detune?: number}} opts fs 采样率;detune 声道去谐因子
 *   (立体声解相关),默认 1
 */
export class SpringReverb {
  constructor(opts) {
    this.fs = opts.fs;
    const det = opts.detune === undefined ? 1 : opts.detune;
    this.preLp = new OnePoleLP(PRE_LP_FC, this.fs);
    this.preDiff = PREDIFF_MS.map((m) => {
      const ap = new Allpass(Math.round((m * det * this.fs) / 1000));
      ap.a = PREDIFF_GAIN;
      return ap;
    });
    this.loopA = new SpringLoop(this.fs, MAIN_MS_A, AP_MS_A, det);
    this.loopB = new SpringLoop(this.fs, MAIN_MS_B, AP_MS_B, det);
    this.loopC = new SpringLoop(this.fs, MAIN_MS_C, AP_MS_C, det);
    this.time = 2.0; // RT60 目标(s)
    this.dwell = 50; // 0~100
    this.tone = 50; // 0~100
    this.recompute();
  }

  /** TIME:RT60 目标,1~4 s */
  setTime(t) {
    this.time = Math.min(4, Math.max(1, t));
    this.recompute();
  }

  /** DWELL:0~100 → 全通色散强度(弥散密度/啁啾感) */
  setDwell(d) {
    this.dwell = Math.min(100, Math.max(0, d));
    this.recompute();
  }

  /** TONE:0~100 → 阻尼低通 1.2k~7k Hz(对数) */
  setTone(t) {
    this.tone = Math.min(100, Math.max(0, t));
    this.recompute();
  }

  recompute() {
    const a = DWELL_AP_MIN + (DWELL_AP_MAX - DWELL_AP_MIN) * (this.dwell / 100);
    const fc = TONE_FC_MIN * Math.pow(TONE_FC_MAX / TONE_FC_MIN, this.tone / 100);
    const alpha = 1 - Math.exp((-2 * Math.PI * fc) / this.fs);
    const loops = [this.loopA, this.loopB, this.loopC];
    for (const loop of loops) {
      loop.setApGain(a);
      loop.setDampAlpha(alpha);
      const tEff = loop.effLoopSeconds();
      const comp = onePoleLpMag(alpha, RT60_REF_HZ, this.fs);
      loop.g = Math.min(G_MAX, Math.pow(10, (-3 * tEff) / this.time) / comp);
    }
  }

  /** 处理一个样本,返回湿声(干湿混合由外层完成) */
  process(x) {
    let v = this.preLp.process(x);
    for (const ap of this.preDiff) v = ap.process(v);
    return (this.loopA.process(v) + this.loopB.process(v) + this.loopC.process(v)) / 3;
  }
}

/**
 * 弹簧混响全链路引擎。process(inputs, outputs, params) 语义与
 * AudioWorkletProcessor.process 一致;采样率由构造注入(替代 worklet 全局
 * sampleRate),引擎内不含任何 AudioWorklet API。
 * 每通道独立 SpringReverb 链(通道 0 detune=1,其余 ×1.021 去谐);
 * 干路恒 1,湿声 × MIX/100 线性叠加;每块无条件 setTime/setDwell/setTone
 * (无参数缓存,与原内联处理器一致)。
 */
export class WdfSpringReverbEngine {
  /** @param {number} sampleRate 采样率 */
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    /** @type {SpringReverb[]} 每通道独立链 */
    this.chains = [];
  }

  createChain(ch) {
    return new SpringReverb({ fs: this.sampleRate, detune: ch === 0 ? 1 : 1.021 });
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    while (this.chains.length < input.length) {
      this.chains.push(this.createChain(this.chains.length));
    }
    const time = params.time[0];
    const dwell = params.dwell[0];
    const tone = params.tone[0];
    const mixG = params.mix[0] / 100;

    for (let ch = 0; ch < input.length; ch++) {
      const tank = this.chains[ch];
      tank.setTime(time);
      tank.setDwell(dwell);
      tank.setTone(tone);
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) {
        out[i] = inp[i] + mixG * tank.process(inp[i]);
      }
    }
    return true;
  }
}
