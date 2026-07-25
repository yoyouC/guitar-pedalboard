/**
 * 临时验证:ac30Worklet.ts 内联处理器 vs ac30Core.ts 参考链 样本级一致性。
 * stub AudioWorklet 全局,提取 processorSource 执行,对比两条路径输出。
 */
import { readFileSync } from 'node:fs';
import { Ac30Chain } from '../src/audio/wdf/ac30Core.ts';
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from '../src/audio/wdf/resample.ts';

const BASE = 48000;
const FS = BASE * OS_FACTOR;

// --- stub AudioWorklet 环境 ---
(globalThis as any).sampleRate = BASE;
(globalThis as any).AudioWorkletProcessor = class {};
let registered: any = null;
(globalThis as any).registerProcessor = (name: string, cls: any) => {
  registered = { name, cls };
};

// --- 提取并执行 processorSource ---
const src = readFileSync('src/audio/wdf/ac30Worklet.ts', 'utf-8');
const m = src.match(/const processorSource = `([\s\S]*?)`;/)!;
if (!m) throw new Error('processorSource 提取失败');
new Function(m[1])(); // 执行 IIFE → registerProcessor
if (!registered) throw new Error('处理器未注册');
console.log('注册名:', registered.name);
if (registered.name !== 'wdf-ac30') throw new Error('注册名错误');

// --- Node 参考链 ---
function makeNodeChain(gain: number, b = 50, mi = 50, t = 50, p = 50) {
  const core = new Ac30Chain(FS, gain, b, mi, t, p);
  const fir = makeAntiAliasFIR();
  const up = new Upsampler4x(fir);
  const down = new Decimator4x(fir);
  const osBuf = new Float32Array(OS_FACTOR);
  return (x: number) => {
    up.process(osBuf, x);
    const y0 = core.process(osBuf[0]);
    const y1 = core.process(osBuf[1]);
    const y2 = core.process(osBuf[2]);
    const y3 = core.process(osBuf[3]);
    return down.process(y0, y1, y2, y3);
  };
}

// --- worklet 处理器实例,块率驱动 ---
function runWorklet(n: number, sig: (i: number) => number, params: Record<string, number>) {
  const proc = new registered.cls();
  const inCh = new Float32Array(128);
  const outCh = new Float32Array(128);
  const p: Record<string, number[]> = {};
  for (const k of ['gain', 'bass', 'mid', 'treble', 'presence']) p[k] = [params[k] ?? 50];
  const out = new Float64Array(n);
  for (let base = 0; base < n; base += 128) {
    for (let i = 0; i < 128; i++) inCh[i] = base + i < n ? sig(base + i) : 0;
    proc.process([[inCh]], [[outCh]], p);
    for (let i = 0; i < 128 && base + i < n; i++) out[base + i] = outCh[i];
  }
  return out;
}

function compare(label: string, params: Record<string, number>) {
  const N = Math.round(BASE * 0.7);
  const sig = (i: number) => 0.2 * Math.sin((2 * Math.PI * 1000 * i) / BASE);
  const w = runWorklet(N, sig, params);
  const node = makeNodeChain(params.gain, params.bass, params.mid, params.treble, params.presence);
  let maxErr = 0, maxRef = 0;
  for (let i = 0; i < N; i++) {
    const r = node(sig(i));
    if (i >= BASE / 2) {
      maxErr = Math.max(maxErr, Math.abs(r - w[i]));
      maxRef = Math.max(maxRef, Math.abs(r));
    }
  }
  const rel = maxErr / maxRef;
  console.log(`${label}: maxErr=${maxErr.toExponential(2)} maxRef=${maxRef.toFixed(3)} rel=${(rel * 100).toFixed(4)}% ${rel < 0.001 ? '✓' : '✗'}`);
  return rel < 0.001;
}

let ok = true;
ok &&= compare('平直 gain=30', { gain: 30, bass: 50, mid: 50, treble: 50, presence: 50 });
ok &&= compare('热档 gain=80 bass=85 mid=20 treble=75 presence=90', { gain: 80, bass: 85, mid: 20, treble: 75, presence: 90 });
ok &&= compare('满档 gain=100', { gain: 100, bass: 50, mid: 50, treble: 50, presence: 50 });
console.log(ok ? 'worklet 与参考链一致 ✓' : 'worklet 与参考链不一致 ✗');
process.exit(ok ? 0 : 1);
