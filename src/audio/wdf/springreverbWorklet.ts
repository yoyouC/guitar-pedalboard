/**
 * 弹簧混响(Spring Reverb,Fender Twin 弹簧箱风格)AudioWorklet 处理器
 * (Blob 内联,免构建配置)。
 *
 * 链路(每通道独立 SpringReverb 实例,通道 1 延迟 ×1.021 去谐):
 *   输入 → 干路(恒 1)─────────────────────────────┬→ 输出
 *   输入 → 预限带 LP → 预弥散 → 三弹簧反馈环(主延迟 + 6 级全通色散
 *          + 阻尼 LP + RT60 反馈增益)→ 湿声 × MIX ──┘
 * 全链路线性,无过采样。IIFE 隔离全局名,避免多 worklet 注册冲突。
 *
 * DSP 逻辑与 src/audio/wdf/springReverb.ts 一致——改动请两边同步。
 */
const processorSource = `(() => {
const MAIN_MS_A = 23.7;
const AP_MS_A = [5.9, 4.4, 3.7, 3.3, 2.5, 2.1];
const MAIN_MS_B = 31.1;
const AP_MS_B = [5.6, 4.1, 3.4, 3.0, 2.7, 2.2];
const MAIN_MS_C = 27.3;
const AP_MS_C = [5.2, 4.6, 3.6, 2.9, 2.4, 2.0];
const PREDIFF_MS = [4.7, 3.1];
const PREDIFF_GAIN = 0.55;
const HP_FC = 28;
const PRE_LP_FC = 8000;
const TONE_FC_MIN = 1200;
const TONE_FC_MAX = 7000;
const DWELL_AP_MIN = 0.3;
const DWELL_AP_MAX = 0.72;
const RT60_REF_HZ = 500;
const G_MAX = 0.97;

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

class Allpass {
  constructor(n) {
    this.buf = new Float32Array(Math.max(1, n));
    this.idx = 0;
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

function onePoleLpMag(alpha, f, fs) {
  const w = (2 * Math.PI * f) / fs;
  const c = Math.cos(w);
  const b = 1 - alpha;
  return alpha / Math.sqrt(1 + b * b - 2 * b * c);
}

class SpringLoop {
  constructor(fs, mainMs, apMs, detune) {
    this.hp = new OnePoleHP(HP_FC, fs);
    this.mainSec = (mainMs * detune) / 1000;
    this.main = new DelayLine(Math.round((mainMs * detune * fs) / 1000));
    this.apSecs = apMs.map((m) => (m * detune) / 1000);
    this.aps = apMs.map((m) => new Allpass(Math.round((m * detune * fs) / 1000)));
    this.damp = new OnePoleLP(2900, fs);
    this.fb = 0;
    this.g = 0.9;
  }
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

class SpringReverb {
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
    this.time = 2.0;
    this.dwell = 50;
    this.tone = 50;
    this.recompute();
  }
  setTime(t) {
    this.time = Math.min(4, Math.max(1, t));
    this.recompute();
  }
  setDwell(d) {
    this.dwell = Math.min(100, Math.max(0, d));
    this.recompute();
  }
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
  process(x) {
    let v = this.preLp.process(x);
    for (const ap of this.preDiff) v = ap.process(v);
    return (this.loopA.process(v) + this.loopB.process(v) + this.loopC.process(v)) / 3;
  }
}

class WdfSpringReverbProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'time', defaultValue: 2.0, minValue: 1, maxValue: 4 },
      { name: 'dwell', defaultValue: 50, minValue: 0, maxValue: 100 },
      { name: 'tone', defaultValue: 50, minValue: 0, maxValue: 100 },
      { name: 'mix', defaultValue: 30, minValue: 0, maxValue: 100 },
    ];
  }

  constructor() {
    super();
    this.chains = [];
  }

  createChain(ch) {
    return new SpringReverb({ fs: sampleRate, detune: ch === 0 ? 1 : 1.021 });
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

registerProcessor('wdf-springreverb', WdfSpringReverbProcessor);
})();`;

let loaded = false;

/** 幂等加载,使用前必须先 await */
export async function loadSpringReverbWdf(ctx: AudioContext): Promise<void> {
  if (loaded) return;
  const url = URL.createObjectURL(
    new Blob([processorSource], { type: 'application/javascript' }),
  );
  try {
    await ctx.audioWorklet.addModule(url);
    loaded = true;
  } finally {
    URL.revokeObjectURL(url);
  }
}
