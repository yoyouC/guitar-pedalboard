/**
 * L4:WDF Big Muff Pi vs ngspice 参考电路(样本级对比)。
 * 网表见 scripts/spice/bigmuff.cir(sustain=0.5, tone=0.5,50mV 1kHz)。
 * 输出 RMSE / RMS 差 / 峰值 / THD 对比。目标:相对 RMSE<25%,RMS 差 <3dB。
 */
import { execFileSync } from 'node:child_process';
import { BigMuffChain } from '../src/audio/wdf/bigmuff.ts';
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from '../src/audio/wdf/resample.ts';

const BASE = 48000;
const FS = BASE * OS_FACTOR;
const N = 4800; // 100ms 窗 = 1kHz 整数 100 周期(DFT 无泄漏)

// ---------- 1) 跑 ngspice ----------
console.log('运行 ngspice 参考仿真…');
const raw = execFileSync('ngspice', ['-b', 'scripts/spice/bigmuff.cir'], {
  encoding: 'utf-8',
  maxBuffer: 64 * 1024 * 1024,
});

// 解析 .print 输出:行格式 "index time v(out) v(in)"
const spiceOut: number[] = [];
for (const line of raw.split('\n')) {
  const m = line.trim().match(/^\d+\s+([-\d.e+]+)\s+([-\d.e+]+)\s+([-\d.e+]+)\s*$/);
  if (m) spiceOut.push(parseFloat(m[2]));
}
console.log(`ngspice 样本数: ${spiceOut.length}`);
if (spiceOut.length < N) {
  console.error('ngspice 输出样本不足,检查网表/版本');
  process.exit(1);
}
spiceOut.length = N;

// ---------- 2) WDF 链(sustain=0.5, tone=0.5;0.5s 建立,同 spice 500ms 起点) ----------
const chain = new BigMuffChain(FS);
chain.setSustain(0.5);
chain.setTone(0.5);
const fir = makeAntiAliasFIR();
const up = new Upsampler4x(fir);
const down = new Decimator4x(fir);
const osBuf = new Float32Array(OS_FACTOR);
const osOut = [0, 0, 0, 0];
const wdf = (x: number): number => {
  up.process(osBuf, x);
  for (let k = 0; k < OS_FACTOR; k++) osOut[k] = chain.process(osBuf[k]);
  return down.process(osOut[0], osOut[1], osOut[2], osOut[3]);
};

const SETTLE = BASE / 2; // 0.5s ≥ 10τ(最慢极点 3.2Hz)
const wdfOut: number[] = [];
for (let n = 0; n < SETTLE + N; n++) {
  // spice 初相 90°(余弦)
  const y = wdf(0.05 * Math.cos((2 * Math.PI * 1000 * n) / BASE));
  if (n >= SETTLE) wdfOut.push(y);
}

// 互相关对齐(±48 样本,覆盖重采样群延迟)
function rmse(a: number[], b: number[], off: number): number {
  let s = 0;
  const n = Math.min(a.length, b.length - Math.abs(off));
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i + off];
    s += d * d;
  }
  return Math.sqrt(s / n);
}
let best = { off: 0, err: Infinity };
for (let off = -48; off <= 48; off++) {
  const e = rmse(spiceOut, wdfOut, off);
  if (e < best.err) best = { off, err: e };
}

const spiceRms = Math.sqrt(spiceOut.reduce((s, v) => s + v * v, 0) / N);
const wdfRms = Math.sqrt(wdfOut.reduce((s, v) => s + v * v, 0) / N);

function thd(y: number[], fund: number): number {
  const g = (f: number) => {
    const w = (2 * Math.PI * f) / BASE;
    let re = 0, im = 0;
    for (let n = 0; n < y.length; n++) {
      re += y[n] * Math.cos(w * n);
      im -= y[n] * Math.sin(w * n);
    }
    return (2 * Math.hypot(re, im)) / y.length;
  };
  const f1 = g(fund);
  return Math.sqrt(g(fund * 2) ** 2 + g(fund * 3) ** 2 + g(fund * 4) ** 2 + g(fund * 5) ** 2) / f1;
}
const thdSpice = thd(spiceOut, 1000);
const thdWdf = thd(wdfOut, 1000);

console.log('\n== L4 WDF vs ngspice(50mV 1kHz,sustain=0.5,tone=0.5)==');
console.log(`最优对齐偏移: ${best.off} 样本`);
console.log(`样本 RMSE: ${best.err.toExponential(3)} V`);
console.log(`输出 RMS: spice=${spiceRms.toFixed(4)}V  wdf=${wdfRms.toFixed(4)}V  差=${(20 * Math.log10(wdfRms / spiceRms)).toFixed(2)}dB`);
console.log(`峰值对比: spice max=${Math.max(...spiceOut).toFixed(3)}  wdf max=${Math.max(...wdfOut).toFixed(3)}`);
console.log(`THD: spice=${(thdSpice * 100).toFixed(1)}%  wdf=${(thdWdf * 100).toFixed(1)}%`);

const relErr = best.err / spiceRms;
const dbDiff = Math.abs(20 * Math.log10(wdfRms / spiceRms));
console.log(`相对误差: ${(relErr * 100).toFixed(1)}%`);
if (relErr > 0.25 || dbDiff > 3) {
  console.log('✗ 未达标(RMSE>25% 或 RMS 差>3dB),需要排查模型/参数');
  process.exit(1);
} else {
  console.log(relErr > 0.1 ? '△ 误差偏大但同量级,可作为 v1 通过' : '✓ 高度一致');
}
