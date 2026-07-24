/**
 * L4:WDF Fuzz Face vs ngspice 参考电路(样本级对比)。
 * 网表见 scripts/spice/fuzzface.cir(50mV 1kHz,fuzz=0.5,IS=1e-7 BF=80 BR=1)。
 * 输出 RMSE / RMS / 峰值 / THD 对比。目标:RMSE<25%、RMS 差 <3dB。
 * 用法: node scripts/wdf-fuzzface-spice-compare.ts
 */
import { execFileSync } from 'node:child_process';
import { FuzzFaceStage } from '../src/audio/wdf/fuzzFaceStage.ts';
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from '../src/audio/wdf/resample.ts';

const BASE = 48000;
const FS = BASE * OS_FACTOR;

// ---------- 1) 跑 ngspice ----------
console.log('运行 ngspice 参考仿真…');
const raw = execFileSync('ngspice', ['-b', 'scripts/spice/fuzzface.cir'], {
  encoding: 'utf-8',
  maxBuffer: 64 * 1024 * 1024,
});

// 按表头列名解析(兼容 .print 分列多表)
function parseCol(rawText: string, name: string): number[] {
  const out: number[] = [];
  let cols: string[] = [];
  for (const line of rawText.split('\n')) {
    const h = line.match(/^Index\s+time\s+(.*)$/);
    if (h) {
      cols = h[1].trim().split(/\s+/);
      continue;
    }
    const m = line.trim().match(/^(\d+)\s+([-\d.e+]+)\s+(.+)$/);
    if (m && cols.length) {
      const idx = cols.indexOf(name);
      if (idx < 0) continue;
      const vals = m[3].trim().split(/\s+/).map(Number);
      if (Number.isFinite(vals[idx])) out.push(vals[idx]);
    }
  }
  return out;
}
const spiceOut = parseCol(raw, 'v(out)');
console.log(`ngspice 样本数: ${spiceOut.length}`);
if (spiceOut.length < 4096) {
  console.error('ngspice 输出样本不足,检查网表/版本');
  process.exit(1);
}
const N = Math.min(8192, spiceOut.length);

// ---------- 2) WDF 链(fuzz=0.5,与 pedal 同构:升采样→放大级→降采样) ----------
const stage = new FuzzFaceStage({ fs: FS });
stage.setFuzz(0.5);
const fir = makeAntiAliasFIR();
const up = new Upsampler4x(fir);
const down = new Decimator4x(fir);
const osBuf = new Float32Array(OS_FACTOR);
const osOut = [0, 0, 0, 0];
const wdf = (x: number): number => {
  up.process(osBuf, x);
  for (let k = 0; k < OS_FACTOR; k++) osOut[k] = stage.process(osBuf[k]);
  return down.process(osOut[0], osOut[1], osOut[2], osOut[3]);
};

// spice 从 OP 启动、100ms 后记录(初相 90°=余弦);WDF 已 DC 初始化,
// 同样跑 0.1s(=100 整周期)建立后取 N,相位天然对齐,再互相关微调
const settle = BASE / 10;
const wdfOut: number[] = [];
for (let n = 0; n < settle + N; n++) {
  const x = 0.05 * Math.cos((2 * Math.PI * 1000 * n) / BASE);
  const y = wdf(x);
  if (n >= settle) wdfOut.push(y);
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

const spiceRms = Math.sqrt(spiceOut.slice(0, N).reduce((s, v) => s + v * v, 0) / N);
const wdfRms = Math.sqrt(wdfOut.slice(0, N).reduce((s, v) => s + v * v, 0) / N);

// THD(整周期:1kHz @48k = 48 样本/周期,取 170 周期 = 8160)
function goertzel(y: number[], f: number): number {
  const n = y.length;
  const w = (2 * Math.PI * f) / BASE;
  let re = 0, im = 0;
  for (let i = 0; i < n; i++) {
    re += y[i] * Math.cos(w * i);
    im -= y[i] * Math.sin(w * i);
  }
  return (2 * Math.hypot(re, im)) / n;
}
function thdOf(y: number[]): number {
  const w = y.slice(0, 8160);
  const f1 = goertzel(w, 1000);
  const h = [2, 3, 4, 5].map((k) => goertzel(w, 1000 * k));
  return Math.sqrt(h[0] ** 2 + h[1] ** 2 + h[2] ** 2 + h[3] ** 2) / f1;
}
const spiceThd = thdOf(spiceOut);
const wdfThd = thdOf(wdfOut);

console.log('\n== L4 WDF vs ngspice(50mV 1kHz,fuzz=0.5)==');
console.log(`最优对齐偏移: ${best.off} 样本`);
console.log(`样本 RMSE: ${best.err.toExponential(3)} V`);
console.log(`输出 RMS: spice=${spiceRms.toFixed(4)}V  wdf=${wdfRms.toFixed(4)}V  差=${(20 * Math.log10(wdfRms / spiceRms)).toFixed(2)}dB`);
console.log(`峰值对比: spice max=${Math.max(...spiceOut.slice(0, N)).toFixed(3)} min=${Math.min(...spiceOut.slice(0, N)).toFixed(3)}  wdf max=${Math.max(...wdfOut).toFixed(3)} min=${Math.min(...wdfOut).toFixed(3)}`);
console.log(`THD: spice=${(spiceThd * 100).toFixed(1)}%  wdf=${(wdfThd * 100).toFixed(1)}%`);

const relErr = best.err / spiceRms;
const rmsDb = Math.abs(20 * Math.log10(wdfRms / spiceRms));
console.log(`相对误差: ${(relErr * 100).toFixed(1)}%`);
let fail = 0;
if (relErr > 0.25) {
  console.log('✗ 相对误差 >25%,需要排查模型/参数');
  fail = 1;
} else {
  console.log(relErr > 0.1 ? '△ 误差偏大但同量级,可作为 v1 通过' : '✓ 高度一致');
}
if (rmsDb > 3) {
  console.log(`✗ RMS 差 ${rmsDb.toFixed(2)}dB > 3dB`);
  fail = 1;
} else {
  console.log(`✓ RMS 差 ${rmsDb.toFixed(2)}dB ≤ 3dB`);
}
if (fail) process.exit(1);
