/**
 * L4:WDF DS-1 vs ngspice 参考电路(样本级对比)。
 * 网表见 scripts/spice/ds1.cir(50mV 1kHz,dist=0.5, tone=0.5)。
 * 报告 RMSE / RMS 差 / 峰值 / THD;目标:相对 RMSE < 25%,RMS 差 < 3dB。
 */
import { execFileSync } from 'node:child_process';
import { Ds1ClipperStage } from '../src/audio/wdf/ds1Clipper.ts';
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from '../src/audio/wdf/resample.ts';

const BASE = 48000;
const FS = BASE * OS_FACTOR;
const T = 1 / FS;
const N = 48000; // 1s 窗 = 整 1000 个 1kHz 周期(Goertzel 无泄漏)

// ---------- 1) 跑 ngspice ----------
console.log('运行 ngspice 参考仿真…');
const raw = execFileSync('ngspice', ['-b', 'scripts/spice/ds1.cir'], {
  encoding: 'utf-8',
  maxBuffer: 64 * 1024 * 1024,
});

// 解析 .print 输出:行格式 "index time v(out) v(in)"(batch print 表格)
const spiceOut: number[] = [];
const spiceIn: number[] = [];
for (const line of raw.split('\n')) {
  const m = line.trim().match(/^\d+\s+([-\d.e+]+)\s+([-\d.e+]+)\s+([-\d.e+]+)\s*$/);
  if (m) {
    spiceOut.push(parseFloat(m[2]));
    spiceIn.push(parseFloat(m[3]));
  }
}
console.log(`ngspice 样本数: ${spiceOut.length}`);
if (spiceOut.length < N) {
  console.error('ngspice 输出样本不足,检查网表/版本');
  process.exit(1);
}
const spice = spiceOut.slice(0, N);

// ---------- 2) WDF 链(dist=0.5, tone=0.5,与网表同构) ----------
const stage = new Ds1ClipperStage({ fs: FS });
stage.setDist(0.5);
const fir = makeAntiAliasFIR();
const up = new Upsampler4x(fir);
const down = new Decimator4x(fir);
const aHpIn = T / (470e3 * 0.022e-6 + T);
const aToneLp = T / (2.2e3 * 0.1e-6 + T);
const aToneHp = T / (2.2e3 * 0.01e-6 + T);
let hpInY1 = 0, toneLpY1 = 0, toneHpY1 = 0;
const osBuf = new Float32Array(OS_FACTOR);
const osOut = [0, 0, 0, 0];
const wdf = (x: number): number => {
  up.process(osBuf, x);
  for (let k = 0; k < OS_FACTOR; k++) {
    hpInY1 += aHpIn * (osBuf[k] - hpInY1);
    const hp = osBuf[k] - hpInY1;
    const bst = 2.0 * Math.tanh(2.5 * hp);
    const s = stage.process(bst);
    toneLpY1 += aToneLp * (s - toneLpY1);
    toneHpY1 += aToneHp * (s - toneHpY1);
    osOut[k] = 0.5 * toneLpY1 + 0.5 * (s - toneHpY1);
  }
  return down.process(osOut[0], osOut[1], osOut[2], osOut[3]);
};

// 建立期 ≥0.5s(§4.2),再取 48000 样本;spice 初相 90°(余弦)
const SETTLE = BASE / 2;
const wdfOut: number[] = [];
for (let n = 0; n < SETTLE + N; n++) {
  const x = 0.05 * Math.cos((2 * Math.PI * 1000 * n) / BASE);
  const y = wdf(x);
  if (n >= SETTLE) wdfOut.push(y);
}

// ---------- 3) 对齐与指标 ----------
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
  const e = rmse(spice, wdfOut, off);
  if (e < best.err) best = { off, err: e };
}

const rmsOf = (y: number[]) => Math.sqrt(y.reduce((s, v) => s + v * v, 0) / y.length);
const spiceRms = rmsOf(spice);
const wdfRms = rmsOf(wdfOut);
const rmsDb = 20 * Math.log10(wdfRms / spiceRms);

/** Goertzel 单频幅度(整周期窗) */
function goertzel(y: number[], freq: number): number {
  const w = (2 * Math.PI * freq) / BASE;
  let re = 0, im = 0;
  for (let n = 0; n < y.length; n++) {
    re += y[n] * Math.cos(w * n);
    im -= y[n] * Math.sin(w * n);
  }
  return (2 * Math.hypot(re, im)) / y.length;
}
function thdOf(y: number[]): number {
  const f1 = goertzel(y, 1000);
  let h = 0;
  for (let k = 2; k <= 9; k++) h += goertzel(y, 1000 * k) ** 2;
  return Math.sqrt(h) / f1;
}
const spiceThd = thdOf(spice);
const wdfThd = thdOf(wdfOut);

const spicePeak = Math.max(...spice);
const wdfPeak = Math.max(...wdfOut);

console.log('\n== L4 WDF vs ngspice(50mV 1kHz,dist=0.5,tone=0.5)==');
console.log(`最优对齐偏移: ${best.off} 样本`);
console.log(`样本 RMSE: ${best.err.toExponential(3)} V`);
console.log(`输出 RMS: spice=${spiceRms.toFixed(4)}V  wdf=${wdfRms.toFixed(4)}V  差=${rmsDb.toFixed(2)}dB`);
console.log(`峰值对比: spice max=${spicePeak.toFixed(4)}  wdf max=${wdfPeak.toFixed(4)}`);
console.log(`THD(h2~h9): spice=${(spiceThd * 100).toFixed(1)}%  wdf=${(wdfThd * 100).toFixed(1)}%`);

const relErr = best.err / spiceRms;
console.log(`相对误差: ${(relErr * 100).toFixed(1)}%`);
let fail = 0;
if (relErr > 0.25) {
  console.log('✗ 相对误差 >25%,需要排查模型/参数');
  fail = 1;
} else {
  console.log(relErr > 0.1 ? '△ 误差偏大但同量级,可作为 v1 通过' : '✓ 高度一致');
}
if (Math.abs(rmsDb) > 3) {
  console.log('✗ RMS 差 >3dB');
  fail = 1;
}
if (fail) process.exit(1);
