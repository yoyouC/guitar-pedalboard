/**
 * L4:WDF Klon Centaur vs ngspice 参考电路(样本级对比)。
 * 网表见 scripts/spice/klon.cir(knob=0.5,treble 平坦,level 0dB)。
 * 输出 RMSE / RMS 差 / 峰值误差 / THD 对比。
 */
import { execFileSync } from 'node:child_process';
import {
  KlonClipperStage,
  klonDryCoeff,
  klonGainForKnob,
} from '../src/audio/wdf/klonCentaur.ts';
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from '../src/audio/wdf/resample.ts';

const BASE = 48000;
const FS = BASE * OS_FACTOR;
const T = 1 / FS;

// ---------- 1) 跑 ngspice ----------
console.log('运行 ngspice 参考仿真…');
const raw = execFileSync('ngspice', ['-b', 'scripts/spice/klon.cir'], {
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
if (spiceOut.length < 4096) {
  console.error('ngspice 输出样本不足,检查网表/版本');
  process.exit(1);
}
const N = Math.min(4096, spiceOut.length);

// ---------- 2) WDF 链(knob=0.5, treble=50 → 高架 0dB 平坦, level=1) ----------
const knob = 0.5;
const clipper = new KlonClipperStage();
const fir = makeAntiAliasFIR();
const up = new Upsampler4x(fir);
const down = new Decimator4x(fir);
const g = klonGainForKnob(knob);
const dryW = klonDryCoeff(knob);
const aTone = T / (1 / (2 * Math.PI * 3000) + T);
let toneLpY1 = 0;
const osBuf = new Float32Array(OS_FACTOR);
const osOut = [0, 0, 0, 0];
const wdf = (x: number): number => {
  up.process(osBuf, x);
  for (let k = 0; k < OS_FACTOR; k++) {
    const vd = clipper.process(g * osBuf[k]);
    const sum = vd + dryW * osBuf[k];
    toneLpY1 += aTone * (sum - toneLpY1);
    osOut[k] = toneLpY1 + (sum - toneLpY1); // toneG = 1(平坦)
  }
  return down.process(osOut[0], osOut[1], osOut[2], osOut[3]);
};

// 与 spice 对齐:spice 记录窗口 100ms..185.33ms(建立后),WDF 同样跑 100ms 建立再取 N
const settle = BASE / 10; // 100ms
const wdfOut: number[] = [];
for (let n = 0; n < settle + N; n++) {
  // spice 初相 90°(余弦):Vin = 0.05·sin(2π·1000·t + 90°)
  const x = 0.05 * Math.cos((2 * Math.PI * 1000 * n) / BASE);
  const y = wdf(x);
  if (n >= settle) wdfOut.push(y);
}

// 对齐:互相关对齐(±48 样本,覆盖重采样群延迟)
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

// THD 对比:对齐后取 1kHz 整数周期窗(48 样本/周期),Goertzel
function goertzel(y: number[], freq: number): number {
  const n0 = y.length;
  const w = (2 * Math.PI * freq) / BASE;
  let re = 0, im = 0;
  for (let n = 0; n < n0; n++) {
    re += y[n] * Math.cos(w * n);
    im -= y[n] * Math.sin(w * n);
  }
  return (2 * Math.hypot(re, im)) / n0;
}
function thdOf(y: number[]): number {
  const f1 = goertzel(y, 1000);
  const h = Math.sqrt(
    goertzel(y, 2000) ** 2 + goertzel(y, 3000) ** 2 + goertzel(y, 4000) ** 2 + goertzel(y, 5000) ** 2,
  );
  return h / f1;
}
const nThd = Math.floor(Math.min(4080, N - Math.abs(best.off)) / 48) * 48;
const spiceSeg = spiceOut.slice(Math.max(0, best.off), Math.max(0, best.off) + nThd);
const wdfSeg = wdfOut.slice(Math.max(0, -best.off), Math.max(0, -best.off) + nThd);
const spiceThd = thdOf(spiceSeg);
const wdfThd = thdOf(wdfSeg);

console.log('\n== L4 WDF vs ngspice(50mV 1kHz,knob=0.5,treble 平坦)==');
console.log(`最优对齐偏移: ${best.off} 样本`);
console.log(`样本 RMSE: ${best.err.toExponential(3)} V`);
console.log(`输出 RMS: spice=${spiceRms.toFixed(4)}V  wdf=${wdfRms.toFixed(4)}V  差=${(20 * Math.log10(wdfRms / spiceRms)).toFixed(2)}dB`);
console.log(`峰值对比: spice max=${Math.max(...spiceOut.slice(0, N)).toFixed(4)}  wdf max=${Math.max(...wdfOut).toFixed(4)}`);
console.log(`THD 对比: spice=${(spiceThd * 100).toFixed(2)}%  wdf=${(wdfThd * 100).toFixed(2)}%`);

const relErr = best.err / spiceRms;
console.log(`相对误差: ${(relErr * 100).toFixed(1)}%`);
if (relErr > 0.25) {
  console.log('✗ 相对误差 >25%,需要排查模型/参数');
  process.exit(1);
} else {
  console.log(relErr > 0.1 ? '△ 误差偏大但同量级,可作为 v1 通过' : '✓ 高度一致');
}
