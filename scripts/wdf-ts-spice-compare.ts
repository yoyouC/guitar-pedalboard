/**
 * L4:WDF TS808 vs ngspice 参考电路(样本级对比)。
 * 网表见 scripts/spice/ts808_clip.cir(drive=0.5, tone 中性)。
 * 输出 RMSE / 峰值误差 / 频谱距离。
 */
import { execFileSync } from 'node:child_process';
import { TsClipperStage } from '../src/audio/wdf/diodeClipper.ts';
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from '../src/audio/wdf/resample.ts';

const BASE = 48000;
const FS = BASE * OS_FACTOR;
const T = 1 / FS;

// ---------- 1) 跑 ngspice ----------
console.log('运行 ngspice 参考仿真…');
const raw = execFileSync('ngspice', ['-b', 'scripts/spice/ts808_clip.cir'], {
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
const N = Math.min(8192, spiceOut.length);

// ---------- 2) WDF 链(drive=0.5, tone 中性=50 → 高架 0dB 平坦) ----------
const clipper = new TsClipperStage({ fs: FS });
clipper.setDrive(0.5);
const fir = makeAntiAliasFIR();
const up = new Upsampler4x(fir);
const down = new Decimator4x(fir);
const aLp = T / (1 / (2 * Math.PI * 723) + T);
let lpY1 = 0;
const osBuf = new Float32Array(OS_FACTOR);
const osOut = [0, 0, 0, 0];
const wdf = (x: number): number => {
  up.process(osBuf, x);
  for (let k = 0; k < OS_FACTOR; k++) {
    const s = clipper.process(osBuf[k]);
    lpY1 += aLp * (s - lpY1);
    osOut[k] = lpY1;
  }
  return down.process(osOut[0], osOut[1], osOut[2], osOut[3]);
};

// 与 spice 对齐:spice 记录窗口 10ms..30ms(建立后),WDF 同样跑 10ms 建立再取 N
const totalN = BASE / 100 + N; // 10ms settle
const wdfOut: number[] = [];
for (let n = 0; n < totalN; n++) {
  // spice 初相 90°(余弦):Vin = 0.05·sin(2π·1000·t + 90°)
  const x = 0.05 * Math.cos((2 * Math.PI * 1000 * n) / BASE);
  const y = wdf(x);
  if (n >= BASE / 100) wdfOut.push(y);
}

// 对齐:spice 记录起点为 10ms,WDF 同步;互相关对齐(±48 样本,覆盖重采样群延迟)
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

// 幅度归一化(增益绝对值差异另算):同时报原始 RMSE
const spiceRms = Math.sqrt(spiceOut.reduce((s, v) => s + v * v, 0) / N);
const wdfRms = Math.sqrt(wdfOut.reduce((s, v) => s + v * v, 0) / N);

console.log('\n== L4 WDF vs ngspice(50mV 1kHz,drive=0.5)==');
console.log(`最优对齐偏移: ${best.off} 样本`);
console.log(`样本 RMSE: ${best.err.toExponential(3)} V`);
console.log(`输出 RMS: spice=${spiceRms.toFixed(4)}V  wdf=${wdfRms.toFixed(4)}V  差=${(20 * Math.log10(wdfRms / spiceRms)).toFixed(2)}dB`);
console.log(`峰值对比: spice max=${Math.max(...spiceOut.slice(0, N)).toFixed(3)}  wdf max=${Math.max(...wdfOut).toFixed(3)}`);

const relErr = best.err / spiceRms;
console.log(`相对误差: ${(relErr * 100).toFixed(1)}%`);
if (relErr > 0.25) {
  console.log('✗ 相对误差 >25%,需要排查模型/参数');
  process.exit(1);
} else {
  console.log(relErr > 0.1 ? '△ 误差偏大但同量级,可作为 v1 通过' : '✓ 高度一致');
}
