/**
 * 离线电平校准:用内置 guitar-riff.wav 标定各效果器/箱头/箱体的
 * Level(Master)默认值,使默认参数下"接通 ≈ 旁通"响度一致(RMS 匹配)。
 *
 * 原理:在 Mock AudioContext 中以真实效果器代码渲染 riff(Level 强制 0dB),
 * 比较输出与干声 RMS,差值即为该模块应使用的默认 Level(dB)。
 *
 * 运行:npm run calibrate
 * 注意:Mock 未实现 WaveShaper 过采样(对 RMS 影响可忽略);
 * 修改 src/audio 中链路结构后,重跑本脚本更新默认值即可,无需同步两处代码。
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';

const RIFF_PATH = new URL('../public/samples/guitar-riff.wav', import.meta.url).pathname;

// ---------- WAV 读取(16bit PCM,混为单声道) ----------
function readWavMono(path) {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 WAV 文件');
  }
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(body, body + size);
    }
    offset = body + size + (size % 2);
  }
  if (!fmt || !data || fmt.format !== 1 || fmt.bits !== 16) {
    throw new Error(`暂不支持的 WAV 格式: ${JSON.stringify(fmt)}`);
  }
  const frames = data.length / 2 / fmt.channels;
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let ch = 0; ch < fmt.channels; ch++) {
      s += data.readInt16LE((i * fmt.channels + ch) * 2) / 32768;
    }
    mono[i] = s / fmt.channels;
  }
  return { samples: mono, sampleRate: fmt.sampleRate };
}

// ---------- RBJ biquad(与 Web Audio 规范同公式,搁架 S=1) ----------
function biquadCoeffs(type, freq, q, gainDb, fs) {
  const w0 = (2 * Math.PI * freq) / fs;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const A = Math.pow(10, gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lowpass' || type === 'highpass') {
    const alpha = sinw / (2 * q);
    const c1 = type === 'lowpass' ? (1 - cosw) / 2 : (1 + cosw) / 2;
    b0 = c1;
    b1 = type === 'lowpass' ? 1 - cosw : -(1 + cosw);
    b2 = c1;
    a0 = 1 + alpha;
    a1 = -2 * cosw;
    a2 = 1 - alpha;
  } else if (type === 'peaking') {
    const alpha = sinw / (2 * q);
    b0 = 1 + alpha * A;
    b1 = -2 * cosw;
    b2 = 1 - alpha * A;
    a0 = 1 + alpha / A;
    a1 = -2 * cosw;
    a2 = 1 - alpha / A;
  } else if (type === 'lowshelf' || type === 'highshelf') {
    // RBJ 搁架(S=1);两种搁架的符号模式不同,显式展开
    const alpha = (sinw / 2) * Math.SQRT2;
    const sq = 2 * Math.sqrt(A) * alpha;
    if (type === 'lowshelf') {
      b0 = A * (A + 1 - (A - 1) * cosw + sq);
      b1 = 2 * A * (A - 1 - (A + 1) * cosw);
      b2 = A * (A + 1 - (A - 1) * cosw - sq);
      a0 = A + 1 + (A - 1) * cosw + sq;
      a1 = -2 * (A - 1 + (A + 1) * cosw);
      a2 = A + 1 + (A - 1) * cosw - sq;
    } else {
      b0 = A * (A + 1 + (A - 1) * cosw + sq);
      b1 = -2 * A * (A - 1 + (A + 1) * cosw);
      b2 = A * (A + 1 + (A - 1) * cosw - sq);
      a0 = A + 1 - (A - 1) * cosw + sq;
      a1 = 2 * (A - 1 - (A + 1) * cosw);
      a2 = A + 1 - (A - 1) * cosw - sq;
    }
  } else {
    throw new Error(`不支持的滤波类型: ${type}`);
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function biquadRun(c, x) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = c.b0 * xi + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi;
    y[i] = yi;
  }
  return y;
}

// ---------- Mock Web Audio 节点(带真实 DSP) ----------
class MockParam {
  constructor(v = 0) { this.value = v; }
  setTargetAtTime(v) { this.value = v; }
  setValueAtTime(v) { this.value = v; }
  linearRampToValueAtTime(v) { this.value = v; }
  exponentialRampToValueAtTime(v) { this.value = v; }
}

class MockNode {
  constructor(ctx, kind) {
    this.ctx = ctx;
    this.kind = kind;
    this.inputs = [];
  }
  connect(dest) { dest.inputs.push(this); return dest; }
  disconnect() {}
  process(x) {
    if (this.kind === 'gain') return x.map((v) => v * this.gain.value);
    if (this.kind === 'biquad') {
      if (!this._c) {
        this._c = biquadCoeffs(this.type, this.frequency.value, this.Q.value, this.gain.value, this.ctx.sampleRate);
      }
      return biquadRun(this._c, x);
    }
    if (this.kind === 'shaper') {
      const curve = this.curve;
      const N = curve.length;
      const y = new Float32Array(x.length);
      for (let i = 0; i < x.length; i++) {
        const idx = Math.min(N - 1, Math.max(0, ((x[i] + 1) / 2) * (N - 1)));
        const lo = Math.floor(idx);
        const hi = Math.min(N - 1, lo + 1);
        y[i] = curve[lo] + (curve[hi] - curve[lo]) * (idx - lo);
      }
      return y;
    }
    throw new Error(`未知节点类型: ${this.kind}`);
  }
}

function createMockCtx(sampleRate) {
  const ctx = {
    sampleRate,
    currentTime: 0,
    createGain() {
      const n = new MockNode(ctx, 'gain');
      n.gain = new MockParam(1);
      return n;
    },
    createBiquadFilter() {
      const n = new MockNode(ctx, 'biquad');
      n.type = 'lowpass';
      n.frequency = new MockParam(350);
      n.Q = new MockParam(1);
      n.gain = new MockParam(0);
      n.detune = new MockParam(0);
      return n;
    },
    createWaveShaper() {
      const n = new MockNode(ctx, 'shaper');
      n.curve = null;
      n.oversample = 'none';
      return n;
    },
  };
  return ctx;
}

// 从 input 节点拓扑递归渲染到 output 节点(支持并联路径求和;目标效果器均无反馈环)
function render(inst, samples) {
  const memo = new Map();
  const signalOf = (node) => {
    if (memo.has(node)) return memo.get(node);
    let buf;
    if (node === inst.input) {
      buf = node.process(samples);
    } else {
      const sum = new Float32Array(samples.length);
      for (const src of node.inputs) {
        const s = signalOf(src);
        for (let i = 0; i < sum.length; i++) sum[i] += s[i];
      }
      buf = node.process(sum);
    }
    memo.set(node, buf);
    return buf;
  };
  return signalOf(inst.output);
}

function rms(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
}
const toDb = (g) => 20 * Math.log10(Math.max(g, 1e-9));

// ---------- 主流程 ----------
const { samples, sampleRate } = readWavMono(RIFF_PATH);
const dryDb = toDb(rms(samples));
let peak = 0;
for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
console.log(`参考源: guitar-riff.wav  ${sampleRate}Hz  峰值 ${toDb(peak).toFixed(1)}dBFS  RMS ${dryDb.toFixed(1)}dBFS\n`);

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
try {
  const ids = ['overdrive', 'ts808', 'klon', 'distortion', 'rat', 'fuzz'];
  const groups = [
    ['效果器', ids, (id) => `/src/audio/effects/${id}.ts`, 'level'],
    ['箱头', ['clean', 'crunch', 'recto', 'chime'], () => '/src/audio/amps.ts', 'master'],
    ['箱体', ['open1x12', 'blue2x12', 'gb4x12', 'v304x12'], () => '/src/audio/cabs.ts', 'level'],
  ];
  const { LEVEL_DB_MIN, LEVEL_DB_MAX } = await server.ssrLoadModule('/src/audio/level.ts');
  const mods = {};
  for (const [label, names, pathFn, levelKey] of groups) {
    console.log(`== ${label} ==`);
    for (const name of names) {
      const path = pathFn(name);
      mods[path] ??= await server.ssrLoadModule(path);
      const mod = mods[path];
      const def =
        mod[`${name}Effect`] ??
        mod.AMP_REGISTRY?.find((d) => d.id === name) ??
        mod.CAB_REGISTRY?.find((d) => d.id === name);
      if (!def) throw new Error(`未找到定义: ${name} @ ${path}`);
      const ctx = createMockCtx(sampleRate);
      const inst = def.create(ctx);
      for (const p of def.params) inst.update(p.key, p.defaultValue);
      inst.update(levelKey, 0); // Level 强制 0dB,测模块本身的净增益
      const wetDb = toDb(rms(render(inst, samples)));
      const suggestedDb = dryDb - wetDb;
      const clamped = Math.min(LEVEL_DB_MAX, Math.max(LEVEL_DB_MIN, suggestedDb));
      const rounded = Math.round(clamped * 2) / 2;
      console.log(
        `  ${name.padEnd(10)} 湿声RMS ${wetDb.toFixed(1).padStart(6)}dB  →  建议默认 ${levelKey} = ${rounded}dB` +
          (rounded !== suggestedDb ? `  (未钳制值 ${suggestedDb.toFixed(1)}dB)` : ''),
      );
    }
    console.log('');
  }
  console.log('提示: 音量踏板为纯增益级,默认固定 0dB,无需校准。');
} finally {
  await server.close();
}
