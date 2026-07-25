/**
 * L4:WDF JC-120 vs ngspice 参考电路(多增益档)。
 * 清音链在全部档位近线性,均可做样本级 RMSE;同时对比 RMS/THD 行为。
 * 目标:RMSE<25%、RMS 差<3dB、THD 行为一致(清音:两侧 THD 均极低)。
 * 用法: node scripts/wdf-jc120-spice-compare.ts [gain 档,如 "10,40,80"]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { JC120, Jc120Core, jc120Drive } from '../src/audio/wdf/jc120Core.ts';
import {
  makeAntiAliasFIR,
  Upsampler4x,
  Decimator4x,
  OS_FACTOR,
} from '../src/audio/wdf/resample.ts';

const BASE = 48000;
const FS = BASE * OS_FACTOR;
const AMP = 0.05; // 50mV 1kHz
const GAINS = (process.argv[2] ?? '10,40,80').split(',').map(Number);

function runSpice(drive: number): number[] {
  const tpl = readFileSync('scripts/spice/jc120.cir', 'utf-8');
  const netlist = tpl.replace(/Epre pre 0 hpinb 0 [\d.]+/, `Epre pre 0 hpinb 0 ${drive}`);
  writeFileSync('/tmp/jc120_run.cir', netlist);
  const raw = execFileSync('ngspice', ['-b', '/tmp/jc120_run.cir'], {
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
  // spice 侧为归一化前"电压",与 WDF 一样除以 NORM
  return out.map((v) => v / JC120.NORM);
}

/** 与 worklet 同构(CHORUS=0;0.5s 建立期后采 n 个样本) */
function runWdf(gainPct: number, n: number): number[] {
  const core = new Jc120Core(FS);
  core.setGain(gainPct);
  const fir = makeAntiAliasFIR();
  const up = new Upsampler4x(fir);
  const down = new Decimator4x(fir);
  const osBuf = new Float32Array(OS_FACTOR);
  const osOut = new Float32Array(OS_FACTOR);
  const out: number[] = [];
  for (let i = 0; i < BASE / 2 + n; i++) {
    up.process(osBuf, AMP * Math.cos((2 * Math.PI * 1000 * i) / BASE));
    for (let k = 0; k < OS_FACTOR; k++) osOut[k] = core.processOs(osBuf[k]);
    // 建立期也每样本走降采样器,否则 FIR 历史为空污染前 12 个样本(§4.3)
    const y = down.process(osOut[0], osOut[1], osOut[2], osOut[3]);
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
  // 整数周期窗(§4.3):85×48=4080 样本 = 85 个 1kHz 周期,消除泄漏
  const w = y.slice(0, 4080);
  const f1 = goertzel(w, 1000);
  const h = Math.hypot(
    goertzel(w, 2000), goertzel(w, 3000), goertzel(w, 4000), goertzel(w, 5000),
  );
  return (h / f1) * 100;
}

console.log('== L4 WDF JC-120 vs ngspice(50mV 1kHz,多增益档)==');
for (const g of GAINS) {
  const drive = jc120Drive(g);
  const spice = runSpice(drive);
  const wdf = runWdf(g, 4096);
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
    `GAIN=${String(g).padStart(3)} (drive ${drive.toFixed(1)}) | RMSE ${rel.toFixed(1)}%(off ${best.off}) | ` +
      `RMS ${sRms.toFixed(4)}/${wRms.toFixed(4)} (${(20 * Math.log10(wRms / sRms)).toFixed(2)}dB) | ` +
      `THD ${sThd.toFixed(3)}%/${wThd.toFixed(3)}% | ` +
      `峰值 ${Math.max(...spice).toFixed(4)}/${Math.max(...wdf).toFixed(4)}`,
  );
}
