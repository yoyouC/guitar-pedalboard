/**
 * L4:WDF RAT vs ngspice 参考电路(样本级对比)。
 * 网表见 scripts/spice/rat.cir(drive=0.5, filter=35 → 7338Hz)。
 * 报告 RMSE / RMS 差 / THD / 峰值;通过判据:相对 RMSE <25% 且 RMS 差 <3dB。
 */
import { execFileSync } from 'node:child_process';
import { RatStage } from '../src/audio/wdf/ratDistortion.ts';
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from '../src/audio/wdf/resample.ts';

const BASE = 48000;
const FS = BASE * OS_FACTOR;

// ---------- 1) 跑 ngspice ----------
console.log('运行 ngspice 参考仿真…');
const raw = execFileSync('ngspice', ['-b', 'scripts/spice/rat.cir'], {
  encoding: 'utf-8',
  maxBuffer: 64 * 1024 * 1024,
});

// 解析 .print 输出:行格式 "index time v(out) v(in)"(batch print 表格)
const spiceOut: number[] = [];
for (const line of raw.split('\n')) {
  const m = line.trim().match(/^\d+\s+([-\d.e+]+)\s+([-\d.e+]+)\s+([-\d.e+]+)\s*$/);
  if (m) spiceOut.push(parseFloat(m[2]));
}
console.log(`ngspice 样本数: ${spiceOut.length}`);
if (spiceOut.length < 4096) {
  console.error('ngspice 输出样本不足,检查网表/版本');
  process.exit(1);
}
const N = Math.min(9600, spiceOut.length); // 9600 = 1kHz 的 200 整周期

// ---------- 2) WDF 链(drive=0.5, filter=35,level=1) ----------
const rat = new RatStage({ fs: FS });
rat.setDrive(0.5);
rat.setFilter(35);
const fir = makeAntiAliasFIR();
const up = new Upsampler4x(fir);
const down = new Decimator4x(fir);
const osBuf = new Float32Array(OS_FACTOR);
const wdf = (x: number): number => {
  up.process(osBuf, x);
  const y0 = rat.process(osBuf[0]);
  const y1 = rat.process(osBuf[1]);
  const y2 = rat.process(osBuf[2]);
  const y3 = rat.process(osBuf[3]);
  return down.process(y0, y1, y2, y3);
};

// WDF 侧 0.5s 建立(§4.2)后取 N;输入与 spice 同相:50mV 余弦
const wdfOut: number[] = [];
const SETTLE = BASE / 2;
for (let n = 0; n < SETTLE + N; n++) {
  const y = wdf(0.05 * Math.cos((2 * Math.PI * 1000 * n) / BASE));
  if (n >= SETTLE) wdfOut.push(y);
}

// ---------- 3) 互相关对齐(覆盖重采样群延迟)----------
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
for (let off = -96; off <= 96; off++) {
  const e = rmse(spiceOut, wdfOut, off);
  if (e < best.err) best = { off, err: e };
}

const spiceRms = Math.sqrt(spiceOut.reduce((s, v) => s + v * v, 0) / N);
const wdfRms = Math.sqrt(wdfOut.reduce((s, v) => s + v * v, 0) / N);
const rmsDbDiff = 20 * Math.log10(wdfRms / spiceRms);

/** Goertzel 幅度(9600 样本 = 200 整周期,无泄漏) */
function goertzel(y: number[], freq: number): number {
  const w = (2 * Math.PI * freq) / BASE;
  let re = 0, im = 0;
  for (let n = 0; n < N; n++) {
    re += y[n] * Math.cos(w * n);
    im -= y[n] * Math.sin(w * n);
  }
  return (2 * Math.hypot(re, im)) / N;
}
function thdOf(y: number[]): number {
  const f1 = goertzel(y, 1000);
  const h = Math.sqrt(
    goertzel(y, 2000) ** 2 + goertzel(y, 3000) ** 2 + goertzel(y, 4000) ** 2 + goertzel(y, 5000) ** 2,
  );
  return h / f1;
}
const spiceThd = thdOf(spiceOut);
const wdfThd = thdOf(wdfOut);

console.log('\n== L4 WDF RAT vs ngspice(50mV 1kHz,drive=0.5,filter=35)==');
console.log(`最优对齐偏移: ${best.off} 样本`);
console.log(`样本 RMSE: ${best.err.toExponential(3)} V`);
console.log(`输出 RMS: spice=${spiceRms.toFixed(4)}V  wdf=${wdfRms.toFixed(4)}V  差=${rmsDbDiff.toFixed(2)}dB`);
console.log(`THD: spice=${(spiceThd * 100).toFixed(1)}%  wdf=${(wdfThd * 100).toFixed(1)}%`);
console.log(
  `峰值对比: spice max=${Math.max(...spiceOut.slice(0, N)).toFixed(3)}  wdf max=${Math.max(...wdfOut).toFixed(3)}`,
);

const relErr = best.err / spiceRms;
console.log(`相对误差: ${(relErr * 100).toFixed(1)}%`);
if (relErr > 0.25 || Math.abs(rmsDbDiff) > 3) {
  console.log('✗ 未达标(RMSE>25% 或 RMS 差>3dB),需要排查模型/参数');
  process.exit(1);
} else {
  console.log(relErr > 0.1 ? '△ 误差偏大但同量级,可作为 v1 通过' : '✓ 高度一致');
}
