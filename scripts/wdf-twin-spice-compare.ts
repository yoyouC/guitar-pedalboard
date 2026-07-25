/**
 * L4:WDF Twin vs ngspice 参考电路(多增益档)。
 * 50mV 1kHz 输入;低增益(近线性区)做样本级 RMSE,高增益做行为级对比
 * (THD/RMS/峰值)。目标:RMSE<25%、RMS 差<3dB、THD 行为一致。
 * 用法: node scripts/wdf-twin-spice-compare.ts [gains,如 "25,50,85,100"]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { TwinStage, KOREN_6L6_APPROX } from '../src/audio/wdf/twinStages.ts';
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from '../src/audio/wdf/resample.ts';

const BASE = 48000;
const FS = BASE * OS_FACTOR;
const T = 1 / FS;
const GAINS = (process.argv[2] ?? '25,50,85,100').split(',').map(Number);
const ATT_PW = 0.6;
const volOf = (g: number) => 0.4 * Math.pow(g / 100, 2);

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

/** 替换 volume 分压电阻(Ra+Rb=1M 保持级1负载 1M 不变)后跑 ngspice */
function runSpice(ra: number, rb: number): number[] {
  const tpl = readFileSync('scripts/spice/twin.cir', 'utf-8');
  const netlist = tpl
    .replace(/Ra1 g2a g2 [\d.]+k/, `Ra1 g2a g2 ${ra}k`)
    .replace(/Rb1 g2 0 [\d.]+k/, `Rb1 g2 0 ${rb}k`);
  writeFileSync('/tmp/twin_run.cir', netlist);
  const raw = execFileSync('ngspice', ['-b', '/tmp/twin_run.cir'], {
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

function runWdf(vol: number, n: number): number[] {
  const st1 = new TwinStage({ fs: FS, Rk: 1.5e3, Ck: 25e-6, Co: 22e-9, Rs: 34e3 });
  const st2 = new TwinStage({ fs: FS, Rk: 1.5e3, Ck: 25e-6, Co: 22e-9, Rs: 100e3 });
  const cf = new TwinStage({
    fs: FS, Rp: 0, Rk: 100e3, Ck: 0, Co: 22e-9, Rs: 47e3, Vbias: 95, cathodeTap: true,
  });
  const pw = new TwinStage({
    fs: FS, koren: KOREN_6L6_APPROX, Bplus: 420, Rp: 2e3, Rk: 250, Ck: 0,
    Co: 1e-3, Rload: 1e6, Rs: 220e3,
  });
  const xfHp = makeHp(60), xfLp = makeLp(5500);
  const fir = makeAntiAliasFIR();
  const up = new Upsampler4x(fir);
  const down = new Decimator4x(fir);
  const osBuf = new Float32Array(OS_FACTOR);
  const osOut = [0, 0, 0, 0];
  const out: number[] = [];
  for (let i = 0; i < BASE / 2 + n; i++) {
    up.process(osBuf, 0.05 * Math.cos((2 * Math.PI * 1000 * i) / BASE));
    for (let k = 0; k < OS_FACTOR; k++) {
      const s1 = st1.process(osBuf[k]);
      const s2 = st2.process(s1 * vol);
      const c = cf.process(s2);
      osOut[k] = xfLp(xfHp(pw.process(c * ATT_PW))) / 250;
    }
    // 降采样器建立期也每样本都走(FIR 历史)
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
  const f1 = goertzel(y, 1000);
  const h = Math.hypot(
    goertzel(y, 2000), goertzel(y, 3000), goertzel(y, 4000), goertzel(y, 5000),
  );
  return (h / f1) * 100;
}

console.log('== L4 WDF Twin vs ngspice(50mV 1kHz,多增益档)==');
for (const g of GAINS) {
  const vol = volOf(g);
  const rb = Math.round(vol * 1000);
  const ra = 1000 - rb;
  const spice = runSpice(ra, rb);
  const wdf = runWdf(vol, 4096);
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
    `GAIN=${String(g).padStart(3)}(vol=${vol}) | RMSE ${rel.toFixed(1)}%(off ${best.off}) | ` +
      `RMS ${sRms.toFixed(3)}/${wRms.toFixed(3)} (${(20 * Math.log10(wRms / sRms)).toFixed(1)}dB) | ` +
      `THD ${sThd.toFixed(2)}%/${wThd.toFixed(2)}% | ` +
      `峰值 ${Math.max(...spice).toFixed(3)}/${Math.max(...wdf).toFixed(3)}`,
  );
}
