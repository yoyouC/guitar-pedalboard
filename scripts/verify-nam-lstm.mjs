/**
 * NAM LSTM worklet 数值验证:
 *   1. 用 mock 的 AudioWorklet 环境 eval 真实的 src/audio/namProcessor.js(被测代码 = 运行时代码)
 *   2. 与按 NAM Core C++(NAM/lstm.cpp)语义独立编写的朴素参考实现逐样本对比
 *   3. 用官方 example lstm.nam(hidden=3)+ 随机生成的多层/带 conditioning 模型双重验证
 *
 * 用法: node scripts/verify-nam-lstm.mjs
 */
import { readFileSync } from 'node:fs';

const processorSource = readFileSync(
  new URL('../src/audio/namProcessor.js', import.meta.url),
  'utf8',
);

// ---------- mock AudioWorklet 环境,加载被测处理器 ----------
let ProcessorClass = null;
const AudioWorkletProcessor = class {
  constructor() {
    this.port = { onmessage: null, postMessage() {} };
  }
};
const registerProcessor = (name, cls) => {
  if (name !== 'nam-lstm') throw new Error(`意外注册的处理器: ${name}`);
  ProcessorClass = cls;
};
new Function('AudioWorkletProcessor', 'registerProcessor', processorSource)(
  AudioWorkletProcessor,
  registerProcessor,
);
if (!ProcessorClass) throw new Error('namProcessor.js 未注册处理器');

// ---------- 朴素参考实现(直接翻译 C++:行主序 W、ifgo 门序、权重含 h0/c0) ----------
function buildReference({ inputSize, hiddenSize: H, numLayers, weights }) {
  let off = 0;
  const layers = [];
  for (let l = 0; l < numLayers; l++) {
    const inSize = l === 0 ? inputSize : H;
    const cols = inSize + H;
    const W = [];
    for (let r = 0; r < 4 * H; r++) {
      W.push(Array.from(weights.slice(off + r * cols, off + (r + 1) * cols)));
    }
    off += 4 * H * cols;
    const b = Array.from(weights.slice(off, off + 4 * H));
    off += 4 * H;
    const h = Array.from(weights.slice(off, off + H));
    off += H;
    const c = Array.from(weights.slice(off, off + H));
    off += H;
    layers.push({ W, b, h, c, inSize });
  }
  const headW = Array.from(weights.slice(off, off + H));
  off += H;
  const headB = weights[off];
  off += 1;
  if (off !== weights.length) throw new Error('参考实现: 权重未消费完');

  const sig = (x) => 1 / (1 + Math.exp(-x));
  return (x, cond = []) => {
    let hPrev = null;
    for (let l = 0; l < layers.length; l++) {
      const { W, b, h, c } = layers[l];
      const xv = l === 0 ? [x, ...cond] : hPrev;
      const xh = [...xv, ...h];
      const ifgo = W.map((row, r) => row.reduce((s, w, j) => s + w * xh[j], b[r]));
      for (let k = 0; k < H; k++) {
        c[k] = sig(ifgo[H + k]) * c[k] + sig(ifgo[k]) * Math.tanh(ifgo[2 * H + k]);
        h[k] = sig(ifgo[3 * H + k]) * Math.tanh(c[k]);
      }
      hPrev = h;
    }
    return headW.reduce((s, w, k) => s + w * hPrev[k], headB);
  };
}

// ---------- 驱动 worklet 处理器跑一段信号 ----------
function runWorklet(model, signal, condValues = []) {
  const proc = new ProcessorClass();
  proc.port.onmessage({
    data: {
      type: 'model',
      inputSize: model.inputSize,
      hiddenSize: model.hiddenSize,
      numLayers: model.numLayers,
      weights: model.weights,
    },
  });
  if (condValues.length) {
    proc.port.onmessage({ data: { type: 'conditioning', values: new Float32Array(condValues) } });
  }
  const out = new Float32Array(signal.length);
  const BLOCK = 128;
  for (let start = 0; start < signal.length; start += BLOCK) {
    const inBuf = signal.slice(start, start + BLOCK);
    const outBuf = new Float32Array(inBuf.length);
    proc.process([[inBuf]], [[outBuf]]);
    out.set(outBuf, start);
  }
  return out;
}

function compare(name, model, condValues = []) {
  const N = 4096;
  const signal = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    // 110Hz 正弦(48kHz)+ 幅度起伏 + 几个脉冲,覆盖动态范围
    signal[i] =
      0.7 * Math.sin((2 * Math.PI * 110 * i) / 48000) * (0.3 + 0.7 * Math.abs(Math.sin(i / 700))) +
      (i % 997 === 0 ? 0.9 : 0);
  }
  const ref = buildReference(model);
  const refOut = new Float64Array(N);
  for (let i = 0; i < N; i++) refOut[i] = ref(signal[i], condValues);
  const got = runWorklet(model, signal, condValues);

  let maxDiff = 0;
  let maxAbs = 0;
  for (let i = 0; i < N; i++) {
    maxDiff = Math.max(maxDiff, Math.abs(got[i] - refOut[i]));
    maxAbs = Math.max(maxAbs, Math.abs(refOut[i]));
  }
  const rms = Math.sqrt(refOut.reduce((s, v) => s + v * v, 0) / N);
  console.log(
    `[${name}] 参考输出 |max|=${maxAbs.toFixed(4)} rms=${rms.toFixed(4)} 与 worklet 最大误差=${maxDiff.toExponential(2)}`,
  );
  if (maxAbs < 1e-6) throw new Error(`[${name}] 输出恒为零,模型未生效`);
  if (maxDiff > 1e-4) throw new Error(`[${name}] 与参考实现偏差过大: ${maxDiff}`);
  console.log(`[${name}] ✓ 通过`);
}

// ---------- 用例 1:官方 example lstm.nam ----------
const lstmDemo = JSON.parse(
  readFileSync(new URL('../public/models/lstm-demo.nam', import.meta.url), 'utf8'),
);
if (lstmDemo.architecture !== 'LSTM') throw new Error('lstm-demo.nam 不是 LSTM 架构');
const model1 = {
  inputSize: lstmDemo.config.input_size,
  hiddenSize: lstmDemo.config.hidden_size,
  numLayers: lstmDemo.config.num_layers,
  weights: new Float32Array(lstmDemo.weights),
};
compare(`官方 lstm-demo (H=${model1.hiddenSize}, L=${model1.numLayers})`, model1);

// ---------- 用例 2:随机多层 LSTM(确定性种子)----------
let seed = 42;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return (seed / 0x7fffffff) * 2 - 1;
};
const mkRandom = (inputSize, H, numLayers) => {
  let total = 0;
  for (let l = 0; l < numLayers; l++) {
    const inSize = l === 0 ? inputSize : H;
    total += 4 * H * (inSize + H) + 4 * H + 2 * H;
  }
  total += H + 1;
  const weights = new Float32Array(total);
  for (let i = 0; i < total; i++) weights[i] = rand() * 0.5;
  return { inputSize, hiddenSize: H, numLayers, weights };
};
compare('随机 LSTM (H=16, L=2)', mkRandom(1, 16, 2));

// ---------- 用例 3:带 conditioning 输入(inputSize=3,如 CatLSTM)----------
compare('随机 CatLSTM (inputSize=3, H=8)', mkRandom(3, 8, 1), [0.5, 0.8]);

console.log('\n全部用例通过:worklet 与 C++ 语义参考实现一致。');
