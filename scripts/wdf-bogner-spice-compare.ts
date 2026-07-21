/**
 * L4:WDF Bogner vs ngspice 参考电路(多增益档)。
 * 低增益(近线性区)做样本级 RMSE;高增益做行为级对比(THD/RMS/峰值)。
 * 用法: node scripts/wdf-bogner-spice-compare.ts [gains,如 "1,5,20"]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { TriodeStage, KOREN_EL34_APPROX } from '../src/audio/wdf/triode.ts';
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from '../src/audio/wdf/resample.ts';

const BASE = 48000;
const FS = BASE * OS_FACTOR;
const T = 1 / FS;
const GAINS = (process.argv[2] ?? '1,5,20').split(',').map(Number);

function makeHp(fc: number) {
  let x1 = 0, y1 = 0;
  const rc = 1 / (2 * Math.PI * fc);
  const a = rc / (rc + T);
  return (x: number) => {
    const y = a * (y1 + x - x1);
    x1 = x;
    y1 = y;
    return y;
  };
}
function makeLp(fc: number) {
  let y1 = 0;
  const rc = 1 / (2 * Math.PI * fc);
  const a = T / (rc + T);
  return (x: number) => (y1 = y1 + a * (x - y1));
}

function runSpice(amp: number): number[] {
  const tpl = readFileSync('scripts/spice/bogner.cir', 'utf-8');
  const netlist = tpl.replace(/SIN\(0 [\d.]+ 1000/, `SIN(0 ${amp} 1000`);
  writeFileSync('/tmp/bogner_run.cir', netlist);
  const raw = execFileSync('ngspice', ['-b', '/tmp/bogner_run.cir'], {
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
  return out.map((v) => v / 250);
}

function runWdf(drive: number, n: number): number[] {
  const st1 = new TriodeStage({ fs: FS, Rk: 2.7e3, Ck: 0.68e-6, Rs: 34e3 });
  const st2 = new TriodeStage({ fs: FS, Rk: 10e3, Ck: 0, Rs: 100e3 });
  const st3 = new TriodeStage({ fs: FS, Rk: 820, Ck: 22e-6, Rs: 100e3 });
  const pw = new TriodeStage({
    fs: FS, koren: KOREN_EL34_APPROX, Bplus: 350, Rp: 4e3, Rk: 250, Ck: 0,
    Co: 1e-3, Rload: 1e6, Rs: 220e3,
  });
  const hpIn = makeHp(130), xfHp = makeHp(90), xfLp = makeLp(6000);
  const fir = makeAntiAliasFIR();
  const up = new Upsampler4x(fir);
  const down = new Decimator4x(fir);
  const osBuf = new Float32Array(OS_FACTOR);
  const osOut = [0, 0, 0, 0];
  const out: number[] = [];
  for (let i = 0; i < BASE / 2 + n; i++) {
    up.process(osBuf, 0.05 * Math.cos((2 * Math.PI * 1000 * i) / BASE));
    for (let k = 0; k < OS_FACTOR; k++) {
      const x = hpIn(osBuf[k]);
      const s1 = st1.process(x * drive);
      const s2 = st2.process(s1 * 0.06);
      const s3 = st3.process(s2 * 0.1);
      osOut[k] = xfLp(xfHp(pw.process(s3 * 0.22))) / 250;
    }
    if (i >= BASE / 2) out.push(down.process(osOut[0], osOut[1], osOut[2], osOut[3]));
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
  return (h / f1) * 100;
}

console.log('== L4 WDF Bogner vs ngspice(多档)==');
for (const g of GAINS) {
  const spice = runSpice(0.05 * g);
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
    `GAIN=${String(g).padStart(2)} | RMSE ${(rel).toFixed(1)}%(off ${best.off}) | ` +
      `RMS ${sRms.toFixed(3)}/${wRms.toFixed(3)} (${(20 * Math.log10(wRms / sRms)).toFixed(1)}dB) | ` +
      `THD ${sThd.toFixed(1)}%/${wThd.toFixed(1)}% | ` +
      `峰值 ${Math.max(...spice).toFixed(3)}/${Math.max(...wdf).toFixed(3)}`,
  );
}
