/**
 * 磁带延迟(Echoplex EP-3 风格)的 AudioWorklet 处理器(Blob 内联,免构建配置)。
 *
 * 链路(每通道独立引擎,非线性全部在 4x 过采样域):
 *   输入 → Up4 → 录制软削波(SATURATION)→ (+) 写环行延迟线
 *        → 调制读出头(wow 0.8Hz + flutter 6.4Hz,WOW 深度,Catmull-Rom 插值)
 *        → 磁头损耗 3.3kHz LP + 30Hz HP(每次重复)→ 循环软削波(有界限幅)
 *        → ×FEEDBACK(0~1.1,>1 自激但有界)回写
 *   湿信号 → Down4(48 阶 FIR)→ ×MIX 与恒 1 干路相加。IIFE 隔离全局名。
 *
 * DSP 逻辑与 src/audio/wdf/tapeDelay.ts 一致(含 resample.ts 的 Up4/Down4/FIR)
 * —— 改动请两边同步。离线验证:scripts/wdf-tapedelay-eval.ts。
 */
const processorSource = `(() => {
	const OS = 4, NT = 48;
	const WOW_HZ = 0.8, FLUTTER_HZ = 6.4;
	const WOW_MAX_S = 3e-3, FLUTTER_MAX_S = 0.35e-3;
	const LOOP_LP_HZ = 3300, LOOP_HP_HZ = 30;
	const TIME_MIN_MS = 50, TIME_MAX_MS = 1000;
	const MAX_DELAY_S = 1.1, TIME_SMOOTH_S = 0.03;

	function makeFIR() {
	  const M = NT - 1;
	  const fc = 0.09;
	  const h = new Float32Array(NT);
	  let sum = 0;
	  for (let n = 0; n < NT; n++) {
	    const x = n - M / 2;
	    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
	    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / M) + 0.08 * Math.cos((4 * Math.PI * n) / M);
	    h[n] = sinc * w;
	    sum += h[n];
	  }
	  for (let n = 0; n < NT; n++) h[n] /= sum;
	  return h;
	}

	class Up4 {
	  constructor(h) {
	    this.p = [];
	    const mLen = NT / OS;
	    for (let k = 0; k < OS; k++) {
	      const pk = new Float32Array(mLen);
	      for (let m = 0; m < mLen; m++) pk[m] = OS * h[k + OS * m];
	      this.p.push(pk);
	    }
	    this.hist = new Float32Array(mLen);
	    this.idx = 0;
	  }
	  process(out, xn) {
	    this.idx = (this.idx - 1 + this.hist.length) % this.hist.length;
	    this.hist[this.idx] = xn;
	    for (let k = 0; k < OS; k++) {
	      const pk = this.p[k];
	      let acc = 0, j = this.idx;
	      for (let m = 0; m < pk.length; m++) {
	        acc += pk[m] * this.hist[j];
	        j = (j + 1) % this.hist.length;
	      }
	      out[k] = acc;
	    }
	  }
	}

	class Down4 {
	  constructor(h) {
	    this.h = h;
	    this.hist = new Float32Array(NT);
	    this.idx = 0;
	  }
	  process(y0, y1, y2, y3) {
	    const ys = [y0, y1, y2, y3];
	    for (let k = 0; k < OS; k++) {
	      this.idx = (this.idx - 1 + NT) % NT;
	      this.hist[this.idx] = ys[k];
	    }
	    let acc = 0, j = this.idx;
	    for (let m = 0; m < NT; m++) {
	      acc += this.h[m] * this.hist[j];
	      j = (j + 1) % NT;
	    }
	    return acc;
	  }
	}

	// p=4 代数软削波:小信号增益恒 1,大信号渐近 ±knee,奇对称无 DC
	function tapeSoftClip(x, knee) {
	  const t = x / knee;
	  return x / Math.pow(1 + t * t * t * t, 0.25);
	}

	class TapeDelayEngine {
	  constructor(fs) {
	    this.fsOs = fs * OS;
	    const fir = makeFIR();
	    this.up = new Up4(fir);
	    this.down = new Down4(fir);
	    this.buf = new Float32Array(Math.ceil(MAX_DELAY_S * this.fsOs));
	    this.wIdx = 0;
	    this.aD = 1 - Math.exp(-1 / (TIME_SMOOTH_S * this.fsOs));
	    this.aLp = 1 - Math.exp((-2 * Math.PI * LOOP_LP_HZ) / this.fsOs);
	    this.aHp = 1 - Math.exp((-2 * Math.PI * LOOP_HP_HZ) / this.fsOs);
	    this.dWow = (2 * Math.PI * WOW_HZ) / this.fsOs;
	    this.dFl = (2 * Math.PI * FLUTTER_HZ) / this.fsOs;
	    this.fbGain = 0.4;
	    this.kneeRec = 2;
	    this.kneeLoop = 1.1;
	    this.wetGain = 0.3;
	    this.wowAmpOs = 0;
	    this.flAmpOs = 0;
	    this.dTarget = (400 / 1000) * this.fsOs;
	    this.dSmooth = this.dTarget;
	    this.wowPhase = 0;
	    this.flutterPhase = 0;
	    this.lpY = 0;
	    this.hpY = 0;
	    this.osIn = new Float32Array(OS);
	    this.osOut = [0, 0, 0, 0];
	    this.setWow(30);
	    this.setSaturation(40);
	  }
	  setTime(ms) {
	    const v = Math.min(TIME_MAX_MS, Math.max(TIME_MIN_MS, ms));
	    this.dTarget = (v / 1000) * this.fsOs;
	  }
	  setFeedback(pct) {
	    this.fbGain = Math.min(110, Math.max(0, pct)) / 100;
	  }
	  setWow(v) {
	    const k = Math.min(100, Math.max(0, v)) / 100;
	    this.wowAmpOs = k * WOW_MAX_S * this.fsOs;
	    this.flAmpOs = k * FLUTTER_MAX_S * this.fsOs;
	  }
	  setSaturation(v) {
	    const k = Math.min(100, Math.max(0, v)) / 100;
	    this.kneeRec = 2 * Math.pow(0.125, k);
	    this.kneeLoop = 1.1 - 0.75 * k;
	  }
	  setMix(pct) {
	    this.wetGain = Math.min(100, Math.max(0, pct)) / 100;
	  }
	  process(x) {
	    const len = this.buf.length;
	    this.up.process(this.osIn, x);
	    for (let k = 0; k < OS; k++) {
	      const rec = tapeSoftClip(this.osIn[k], this.kneeRec);
	      this.dSmooth += this.aD * (this.dTarget - this.dSmooth);
	      this.wowPhase += this.dWow;
	      if (this.wowPhase > Math.PI) this.wowPhase -= 2 * Math.PI;
	      this.flutterPhase += this.dFl;
	      if (this.flutterPhase > Math.PI) this.flutterPhase -= 2 * Math.PI;
	      const mod = this.wowAmpOs * Math.sin(this.wowPhase) + this.flAmpOs * Math.sin(this.flutterPhase);
	      let pos = this.wIdx - this.dSmooth - mod;
	      if (pos < 0) pos += len;
	      const i = Math.floor(pos);
	      const f = pos - i;
	      const x0 = this.buf[(i - 1 + len) % len];
	      const x1 = this.buf[i % len];
	      const x2 = this.buf[(i + 1) % len];
	      const x3 = this.buf[(i + 2) % len];
	      const rd = 0.5 * (2 * x1 + (-x0 + x2) * f + (2 * x0 - 5 * x1 + 4 * x2 - x3) * f * f + (-x0 + 3 * x1 - 3 * x2 + x3) * f * f * f);
	      this.lpY += this.aLp * (rd - this.lpY);
	      this.hpY += this.aHp * (this.lpY - this.hpY);
	      const wet = this.lpY - this.hpY;
	      this.buf[this.wIdx] = rec + this.fbGain * tapeSoftClip(wet, this.kneeLoop);
	      this.wIdx = (this.wIdx + 1) % len;
	      this.osOut[k] = wet;
	    }
	    const y = this.down.process(this.osOut[0], this.osOut[1], this.osOut[2], this.osOut[3]);
	    return x + this.wetGain * y;
	  }
	}

	class WdfTapeDelayProcessor extends AudioWorkletProcessor {
	  static get parameterDescriptors() {
	    return [
	      { name: 'time', defaultValue: 400, minValue: 50, maxValue: 1000 },
	      { name: 'feedback', defaultValue: 40, minValue: 0, maxValue: 110 },
	      { name: 'wow', defaultValue: 30, minValue: 0, maxValue: 100 },
	      { name: 'saturation', defaultValue: 40, minValue: 0, maxValue: 100 },
	      { name: 'mix', defaultValue: 30, minValue: 0, maxValue: 100 },
	    ];
	  }

	  constructor() {
	    super();
	    this.engines = [];
	  }

	  process(inputs, outputs, params) {
	    const input = inputs[0];
	    const output = outputs[0];
	    if (!input || !input.length) return true;
	    while (this.engines.length < input.length) this.engines.push(new TapeDelayEngine(sampleRate));
	    for (let ch = 0; ch < input.length; ch++) {
	      const eng = this.engines[ch];
	      eng.setTime(params.time[0]);
	      eng.setFeedback(params.feedback[0]);
	      eng.setWow(params.wow[0]);
	      eng.setSaturation(params.saturation[0]);
	      eng.setMix(params.mix[0]);
	      const inp = input[ch];
	      const out = output[ch];
	      for (let i = 0; i < inp.length; i++) out[i] = eng.process(inp[i]);
	    }
	    return true;
	  }
	}

	registerProcessor('wdf-tapedelay', WdfTapeDelayProcessor);
	})();`;

let loaded = false;

/** 幂等加载,使用前必须先 await */
export async function loadTapeDelayWdf(ctx: AudioContext): Promise<void> {
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
