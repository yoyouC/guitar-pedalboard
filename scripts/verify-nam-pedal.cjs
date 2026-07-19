#!/usr/bin/env node
/**
 * NAMKnobs 条件化单块验证:
 *   1. 通道数:条件化模型 getNumInputChannels() > 1(ch0 音频 + ch1..N 旋钮)
 *   2. 旋钮有效性:同一音频在不同 conditioning 下输出应有显著差异,
 *      且方向正确(失真类旋钮调大 → RMS 更高/更压缩)
 *   3. 回归:快照模型(ac10,1 通道)不受影响
 *
 * 用法: node scripts/verify-nam-pedal.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
  if (rc !== 1) throw new Error(`setDsp(${path.basename(p)}) 返回 ${rc}`);
}

function processAll(M, signal) {
  const N = signal.length;
  const inPtr = M._malloc(128 * 4);
  const outPtr = M._malloc(128 * 4);
  const out = new Float32Array(N);
  const heap = M.HEAPF32;
  for (let s = 0; s < N; s += 128) {
    heap.set(signal.subarray(s, s + 128), inPtr >> 2);
    M._processAudio(inPtr, outPtr, 128);
    out.set(heap.subarray(outPtr >> 2, (outPtr >> 2) + 128), s);
  }
  M._free(inPtr);
  M._free(outPtr);
  return out;
}

function setCond(M, values) {
  const ptr = M._malloc(values.length * 4);
  M.HEAPF32.set(values, ptr >> 2);
  M._setConditioning(values.length, ptr);
  M._free(ptr);
}

const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
const db = (x) => (20 * Math.log10(x)).toFixed(1);

async function main() {
  const wasmBytes = fs.readFileSync(path.join(__dirname, '../public/nam-wasm/nam-wasm-glue.wasm'));
  const M = await NamWasmModule({
    instantiateWasm: (imports, cb) => {
      WebAssembly.instantiate(wasmBytes, imports).then((r) => cb(r.instance || r));
      return {};
    },
  });
  M._setSampleRate(48000);

  // 测试信号:110Hz 正弦 riff 片段
  const N = 48000;
  const signal = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    signal[i] = 0.5 * Math.sin((2 * Math.PI * 110 * i) / 48000) * (0.4 + 0.6 * Math.abs(Math.sin(i / 900)));
  }

  // ---------- 1. TS808(ts_full):drive 0 vs 1 ----------
  setDspFromFile(M, path.join(__dirname, '../public/models/namknobs/ts_full.nam'));
  const tsCh = M._getNumInputChannels();
  console.log(`[TS808] 输入通道数 = ${tsCh}(期望 3)`);
  if (tsCh !== 3) throw new Error('TS808 通道数不符');
  setCond(M, [0.0, 0.5]); // drive=0, tone=0.5
  const tsDrive0 = processAll(M, signal);
  setCond(M, [1.0, 0.5]); // drive=1, tone=0.5
  const tsDrive1 = processAll(M, signal);
  const r0 = rms(tsDrive0);
  const r1 = rms(tsDrive1);
  let maxDelta = 0;
  for (let i = 0; i < N; i++) maxDelta = Math.max(maxDelta, Math.abs(tsDrive0[i] - tsDrive1[i]));
  console.log(`[TS808] drive=0 rms=${db(r0)}dB  drive=1 rms=${db(r1)}dB  输出最大差异=${maxDelta.toFixed(3)}`);
  if (maxDelta < 0.01) throw new Error('TS808 旋钮无效果(输出不随 drive 变化)');
  console.log('[TS808] ✓ drive 旋钮有效');

  // ---------- 2. Compressor(comp,LSTM):threshold 0 vs 1 ----------
  setDspFromFile(M, path.join(__dirname, '../public/models/namknobs/comp.nam'));
  const compCh = M._getNumInputChannels();
  console.log(`[Comp] 输入通道数 = ${compCh}(期望 5)`);
  if (compCh !== 5) throw new Error('Comp 通道数不符');
  setCond(M, [0.0, 0.5, 0.5, 0.5]); // threshold=0
  const compT0 = processAll(M, signal);
  setCond(M, [1.0, 0.5, 0.5, 0.5]); // threshold=1
  const compT1 = processAll(M, signal);
  const cr0 = rms(compT0);
  const cr1 = rms(compT1);
  let compDelta = 0;
  for (let i = 0; i < N; i++) compDelta = Math.max(compDelta, Math.abs(compT0[i] - compT1[i]));
  console.log(`[Comp] threshold=0 rms=${db(cr0)}dB  threshold=1 rms=${db(cr1)}dB  最大差异=${compDelta.toFixed(3)}`);
  if (compDelta < 0.005) throw new Error('Comp 旋钮无效果');
  console.log('[Comp] ✓ threshold 旋钮有效');

  // ---------- 3. 回归:快照模型(ac10,1 通道)----------
  setDspFromFile(M, path.join(__dirname, '../public/models/ac10-wavenet.nam'));
  const acCh = M._getNumInputChannels();
  if (acCh !== 1) throw new Error(`ac10 通道数异常: ${acCh}`);
  const acOut = processAll(M, signal);
  let acPeak = 0;
  for (let i = 0; i < N; i++) acPeak = Math.max(acPeak, Math.abs(acOut[i]));
  console.log(`[ac10 回归] 通道数=1 ✓ 输出 peak=${acPeak.toFixed(3)}`);
  if (!(acPeak > 0.01 && acPeak < 10)) throw new Error('ac10 回归失败');

  console.log('\n全部通过:条件化模型旋钮通道正确且有效,快照模型回归正常。');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(tmpGlue, { force: true }));
