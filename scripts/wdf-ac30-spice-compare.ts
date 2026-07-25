/**
 * L4:WDF AC30 vs ngspice 参考电路(多增益档,50mV 1kHz,平坦音色)。
 * 中间增益档(gain=35)做样本级 RMSE;各档对比 RMS/峰值/THD 行为。
 * 目标:RMSE<25%、RMS 差<3dB、THD 行为一致。
 * 用法: node scripts/wdf-ac30-spice-compare.ts [gain 档,如 "20,35,55"]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { Ac30Chain, AC30, ac30Drive } from '../src/audio/wdf/ac30Core.ts';
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from '../src/audio/wdf/resample.ts';

const BASE = 48000;
const FS = BASE * OS_FACTOR;
const KNOBS = (process.argv[2] ?? '20,35,55').split(',').map(Number);

function runSpice(amp: number): number[] {
  const tpl = readFileSync('scripts/spice/ac30.cir', 'utf-8');
  const netlist = tpl.replace(/SIN\(0 [\d.]+ 1000/, `SIN(0 ${amp} 1000`);
  writeFileSync('/tmp/ac30_run.cir', netlist);
  const raw = execFileSync('ngspice', ['-b', '/tmp/ac30_run.cir'], {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out: number[] = [];
  let cols: string[] = [];
  for (const line of raw.split('\n')) {
    const h = line.match(/^Index\s+time\s+(.*)$/);
    if (h) {
      cols = h[1].trim().split(/\s+/);
      continue;
    }
    const m = line.trim().match(/^(\d+)\s+([-\d.e+]+)\s+(.+)$/);
    if (m && cols.length) {
      const idx = cols.indexOf('v(out)');
      if (idx < 0) continue;
      const vals = m[3].trim().split(/\s+/).map(Number);
      if (Number.isFinite(vals[idx])) out.push(vals[idx]);
    }
  }
  return out.map((v) => v / AC30.NORM);
}

function runWdf(knob: number, n: number): number[] {
  const chain = new Ac30Chain(FS, knob, 50, 50, 50, 50); // 平坦音色(L4 对照档)
  const fir = makeAntiAliasFIR();
  const up = new Upsampler4x(fir);
  const down = new Decimator4x(fir);
  const osBuf = new Float32Array(OS_FACTOR);
  const out: number[] = [];
  for (let i = 0; i < BASE / 2 + n; i++) {
    up.process(osBuf, 0.05 * Math.cos((2 * Math.PI * 1000 * i) / BASE));
    const y0 = chain.process(osBuf[0]);
    const y1 = chain.process(osBuf[1]);
    const y2 = chain.process(osBuf[2]);
    const y3 = chain.process(osBuf[3]);
    // 降采样器必须每样本都走(否则 FIR 历史为空,建立期污染测量)
    const y = down.process(y0, y1, y2, y3);
    if (i >= BASE / 2) out.push(y);
  }
  return out;
}

function goertzel(y: number[], f: number): number {
  const N = y.length;
  const w = (2 * Math.PI * f) / BASE;
  let re = 0, im = 0;
  for (let n = 0; n < N; n++) {
    re += y[n] * Math.cos(w * n);
    im -= y[n] * Math.sin(w * n);
  }
  return (2 * Math.hypot(re, im)) / N;
}

function thdPct(y: number[]): number {
  const f1 = goertzel(y, 1000);
  const h = Math.hypot(
    goertzel(y, 2000), goertzel(y, 3000), goertzel(y, 4000), goertzel(y, 5000),
  );
  return (h / Math.max(1e-12, f1)) * 100;
}

console.log('== L4 WDF AC30 vs ngspice(50mV 1kHz,平坦音色,spice 建立 450ms / WDF 0.5s)==');
for (const knob of KNOBS) {
  const drive = ac30Drive(knob);
  const spice = runSpice(0.05 * drive);
  const wdf = runWdf(knob, 4096);
  const N = Math.min(spice.length, wdf.length);
  // 最优对齐(±48)
  let best = { off: 0, err: Infinity };
  for (let off = -48; off <= 48; off++) {
    let s = 0;
    for (let i = 0; i < N - 48; i++) {
      const d = spice[i] - wdf[i + off];
      s += d * d;
    }
    const e = Math.sqrt(s / (N - 48));
    if (e < best.err) best = { off, err: e };
  }
  const sRms = Math.sqrt(spice.slice(0, N).reduce((s, v) => s + v * v, 0) / N);
  const wRms = Math.sqrt(wdf.slice(0, N).reduce((s, v) => s + v * v, 0) / N);
  const rel = (best.err / Math.max(1e-9, sRms)) * 100;
  const sThd = thdPct(spice.slice(0, N));
  const wThd = thdPct(wdf.slice(0, N));
  console.log(
    `GAIN=${String(knob).padStart(3)}(drive ${drive.toFixed(1).padStart(4)}) | RMSE ${rel.toFixed(1)}%(off ${best.off}) | ` +
      `RMS ${sRms.toFixed(3)}/${wRms.toFixed(3)} (${(20 * Math.log10(wRms / sRms)).toFixed(1)}dB) | ` +
      `THD ${sThd.toFixed(1)}%/${wThd.toFixed(1)}% | ` +
      `峰值 ${Math.max(...spice).toFixed(3)}/${Math.max(...wdf).toFixed(3)}`,
  );
}
