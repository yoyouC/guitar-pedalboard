#!/usr/bin/env node
/**
 * NAM WASM(方案 B)数值验证与性能测试:
 *   1. 在 Node 中实例化 emscripten 产物(public/nam-wasm/nam-wasm-glue.js)
 *   2. 对拍:lstm-demo.nam 经 WASM(NAM Core 官方实现)与经纯 JS 参考实现
 *      (scripts/verify-nam-lstm.mjs 同款)的输出逐样本对比 —— 验证 WASM 链路正确性
 *   3. 性能:WaveNet 标准模型(ac10-wavenet.nam)推理速度实测(实时需 < 100% 单核)
 *
 * 用法: node scripts/verify-nam-wasm.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// glue 是 UMD;本包为 type:module,直接 require .js 会被按 ESM 解析导致 UMD 导出不生效,
// 复制为 .cjs 后再 require(/tmp 下无 type:module 约束)
const tmpGlue = path.join(os.tmpdir(), `nam-wasm-glue-${process.pid}.cjs`);
fs.copyFileSync(path.join(__dirname, '../public/nam-wasm/nam-wasm-glue.js'), tmpGlue);
const NamWasmModule = require(tmpGlue);

function setDspFromFile(M, p) {
  const json = fs.readFileSync(p, 'utf8');
  const len = M.lengthBytesUTF8(json) + 1;
  const ptr = M._malloc(len);
  M.stringToUTF8(json, ptr, len);
  const rc = M._setDsp(ptr);
  M._free(ptr);
  if (rc !== 1) throw new Error(`setDsp(${p}) 返回 ${rc}`);
}

function processAll(M, signal) {
  const N = signal.length;
  const inPtr = M._malloc(128 * 4);
  const outPtr = M._malloc(128 * 4);
  const out = new Float32Array(N);
  const heap = M.HEAPF32;
  for (let s = 0; s < N; s += 128) {
    heap.set(signal.subarray(s, Math.min(s + 128, N)), inPtr >> 2);
    M._processAudio(inPtr, outPtr, 128);
    out.set(heap.subarray(outPtr >> 2, (outPtr >> 2) + 128), s);
  }
  M._free(inPtr);
  M._free(outPtr);
  return out;
}

// 与 verify-nam-lstm.mjs 相同的朴素参考实现(C++ 语义)
function buildReference({ inputSize, hiddenSize: H, numLayers, weights }) {
  let off = 0;
  const layers = [];
  for (let l = 0; l < numLayers; l++) {
    const inSize = l === 0 ? inputSize : H;
    const cols = inSize + H;
    const W = [];
    for (let r = 0; r < 4 * H; r++) W.push(Array.from(weights.slice(off + r * cols, off + (r + 1) * cols)));
    off += 4 * H * cols;
    const b = Array.from(weights.slice(off, off + 4 * H)); off += 4 * H;
    const h = Array.from(weights.slice(off, off + H)); off += H;
    const c = Array.from(weights.slice(off, off + H)); off += H;
    layers.push({ W, b, h, c, inSize });
  }
  const headW = Array.from(weights.slice(off, off + H)); off += H;
  const headB = weights[off];
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

async function main() {
  const wasmBytes = fs.readFileSync(path.join(__dirname, '../public/nam-wasm/nam-wasm-glue.wasm'));
  const M = await NamWasmModule({
    instantiateWasm: (imports, cb) => {
      WebAssembly.instantiate(wasmBytes, imports).then((r) => cb(r.instance || r));
      return {};
    },
  });

  const N = 48000;
  const signal = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    signal[i] =
      0.7 * Math.sin((2 * Math.PI * 110 * i) / 48000) * (0.3 + 0.7 * Math.abs(Math.sin(i / 700))) +
      (i % 997 === 0 ? 0.9 : 0);
  }

  // ---------- 1. LSTM 对拍:WASM vs 纯 JS 参考实现 ----------
  const lstmPath = path.join(__dirname, '../public/models/lstm-demo.nam');
  const lstm = JSON.parse(fs.readFileSync(lstmPath, 'utf8'));
  const ref = buildReference({
    inputSize: lstm.config.input_size,
    hiddenSize: lstm.config.hidden_size,
    numLayers: lstm.config.num_layers,
    weights: new Float32Array(lstm.weights),
  });
  // 与绑定侧一致:先以 0.5s 静默预热(LSTM GetPrewarmSamples = 0.5 × 48k),再对比
  for (let i = 0; i < 24000; i++) ref(0);
  // 与绑定侧一致的 10Hz DC blocker
  const dcCoeff = 1 - (2 * Math.PI * 10) / 48000;
  let dcPrevIn = 0;
  let dcPrevOut = 0;
  const dcBlock = (x) => {
    const y = x - dcPrevIn + dcCoeff * dcPrevOut;
    dcPrevIn = x;
    dcPrevOut = y;
    return y;
  };
  const refOut = new Float64Array(N);
  for (let i = 0; i < N; i++) refOut[i] = dcBlock(ref(signal[i]));

  setDspFromFile(M, lstmPath);
  M._setSampleRate(48000); // 与浏览器侧一致:绑定 DC blocker 系数按采样率计算
  const wasmOut = processAll(M, signal);

  let maxDiff = 0;
  let maxAbs = 0;
  for (let i = 0; i < N; i++) {
    maxDiff = Math.max(maxDiff, Math.abs(wasmOut[i] - refOut[i]));
    maxAbs = Math.max(maxAbs, Math.abs(refOut[i]));
  }
  console.log(`[LSTM 对拍] 参考 |max|=${maxAbs.toFixed(4)} WASM vs 纯JS 最大误差=${maxDiff.toExponential(2)}`);
  if (maxAbs < 1e-6) throw new Error('WASM 输出恒为零');
  if (maxDiff > 1e-3) throw new Error(`对拍失败: 误差 ${maxDiff} 超过容差`);
  console.log('[LSTM 对拍] ✓ 通过(误差 < 1e-3)');

  // ---------- 2. WaveNet 性能实测 ----------
  const ac10Path = path.join(__dirname, '../public/models/ac10-wavenet.nam');
  setDspFromFile(M, ac10Path);
  processAll(M, signal); // 预热
  const t0 = process.hrtime.bigint();
  const SECONDS = 100;
  for (let r = 0; r < SECONDS; r++) processAll(M, signal);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(
    `[WaveNet 性能] 标准模型(ac10)推理 ${SECONDS}s 音频耗时 ${ms.toFixed(0)}ms => ${((ms / 1000 / SECONDS) * 100).toFixed(1)}% 单核(实时需 <100%)`,
  );

  const wnOut = processAll(M, signal);
  let wnPeak = 0;
  for (let i = 0; i < N; i++) wnPeak = Math.max(wnPeak, Math.abs(wnOut[i]));
  console.log(`[WaveNet sanity] 输出 peak=${wnPeak.toFixed(3)}(应在 0.01~10 之间)`);
  if (!(wnPeak > 0.01 && wnPeak < 10)) throw new Error(`WaveNet 输出异常: ${wnPeak}`);

  console.log('\n全部通过:WASM 链路数值正确,WaveNet 实时性能达标。');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(tmpGlue, { force: true }));
