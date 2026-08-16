/**
 * 板式混响(Plate Reverb,EMT-140 风格)正确性评测(L0~L2)
 * Node 直跑:node scripts/wdf-plate-eval.ts
 *
 * 判据(不许放水):
 *  L0 数值健康:无 NaN、输出有界、静音→静音、参数全程扫掠稳定、无极限环
 *  L1 特征指标:
 *    - RT60 = TIME ±15%(DAMP=0:48kHz 9 点全行程 + 44.1k/96kHz × 双 variant 抽查)
 *    - 衰减平滑指数:EDC 线性拟合 R² ≥ 0.995,最大残差 < 1.5dB
 *    - PREDELAY 首达时间 = 预延迟 + 固定扩散延迟,相对误差 ±1.5ms,预延迟前零泄漏
 *    - MIX 等功率交叉:0=全干(精确)、100=全湿、50 湿能量 = 100 湿能量 × sin²(π/4)
 *  L2 行为特征:
 *    - 早期反射密度 ≥ 1000 次/s(前 100ms,-40dB 阈值;Dattorro 回音密度标准)
 *    - 无离散重复:去趋势包络自相关峰值 < 0.35(滞后 30~500ms)
 *    - 频率相关衰减:高频衰减快于中频且 DAMP 可控
 *      (DAMP=0 各频带 RT60 一致 ±12%;DAMP=100 时 8kHz RT60 < 0.65×1kHz;随 DAMP 单调)
 *    - 立体声 variant 0/1 去相关:归一化互相关 < 0.2
 */
import { fileURLToPath } from 'node:url';
import { PlateReverb } from '../src/audio/wdf/plateReverb.dsp.js';
import { buildProcessorSource } from '../src/audio/workletLoader.ts';
import { extractAssembledProcessor } from '../tests/helpers/wdf-golden.ts';

const FS = 48000;

interface ReverbParams {
  time?: number;
  damp?: number; // 0~1
  preDelay?: number; // ms
  mix?: number; // 0~1
  variant?: 0 | 1;
}

function makeReverb(p: ReverbParams, fs: number): PlateReverb {
  const r = new PlateReverb(fs, p.variant ?? 0);
  r.setTime(p.time ?? 2.5);
  r.setDamp(p.damp ?? 0.4);
  r.setPreDelayMs(p.preDelay ?? 0);
  r.setMix(p.mix ?? 1);
  return r;
}

/** 设参后先跑 0.5s 建立期(预延迟读位置平滑收敛,见 docs/wdf-whitebox-process.md §4.2),再打单位脉冲取 IR */
function impulseIR(p: ReverbParams, seconds: number, fs = FS): Float64Array {
  const r = makeReverb(p, fs);
  for (let i = 0; i < fs / 2; i++) r.process(0);
  const n = Math.round(seconds * fs);
  const ir = new Float64Array(n);
  for (let i = 0; i < n; i++) ir[i] = r.process(i === 0 ? 1 : 0);
  return ir;
}

/** Schroeder 反向积分能量衰减曲线(dB) */
function edcDb(y: Float64Array): Float64Array {
  const n = y.length;
  const db = new Float64Array(n);
  let acc = 0;
  for (let i = n - 1; i >= 0; i--) {
    acc += y[i] * y[i];
    db[i] = acc;
  }
  const e0 = db[0];
  for (let i = 0; i < n; i++) db[i] = 10 * Math.log10(Math.max(db[i], 1e-30) / e0);
  return db;
}

/** 在 EDC [loDb, hiDb] 段最小二乘拟合 */
function edcLine(y: Float64Array, fs: number, loDb: number, hiDb: number) {
  const db = edcDb(y);
  let i0 = 0;
  while (i0 < db.length && db[i0] > loDb) i0++;
  let i1 = i0;
  while (i1 < db.length && db[i1] > hiDb) i1++;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, cnt = 0;
  for (let i = i0; i < i1; i++) {
    const t = i / fs;
    sx += t;
    sy += db[i];
    sxx += t * t;
    sxy += t * db[i];
    cnt++;
  }
  const slope = (cnt * sxy - sx * sy) / (cnt * sxx - sx * sx);
  const intercept = (sy - slope * sx) / cnt;
  return { db, i0, i1, slope, intercept, cnt };
}

/** T30 法 RT60 */
function rt60T30(y: Float64Array, fs: number): number {
  const { slope } = edcLine(y, fs, -5, -35);
  return -60 / slope;
}

/** RBJ 二阶带通(0dB 峰值) */
function bandpass(fs: number, f0: number, Q: number) {
  const w0 = (2 * Math.PI * f0) / fs;
  const alpha = Math.sin(w0) / (2 * Q);
  const a0 = 1 + alpha;
  return {
    b0: alpha / a0,
    b1: 0,
    b2: -alpha / a0,
    a1: (-2 * Math.cos(w0)) / a0,
    a2: (1 - alpha) / a0,
  };
}

function filterBiquad(y: Float64Array, c: ReturnType<typeof bandpass>): Float64Array {
  const out = new Float64Array(y.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < y.length; i++) {
    const x = y[i];
    const o = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = o;
    out[i] = o;
  }
  return out;
}

function firstAbove(y: Float64Array, thr: number): number {
  for (let i = 0; i < y.length; i++) if (Math.abs(y[i]) > thr) return i;
  return -1;
}

/** 早期反射密度:[t0,t1] 秒内高于 peak·10^(relDb/20) 的局部极大值个数 / 秒 */
function echoDensity(y: Float64Array, fs: number, t0: number, t1: number, relDb: number): number {
  let peak = 0;
  for (let i = 0; i < y.length; i++) peak = Math.max(peak, Math.abs(y[i]));
  const thr = peak * Math.pow(10, relDb / 20);
  const i0 = Math.round(t0 * fs);
  const i1 = Math.min(y.length - 2, Math.round(t1 * fs));
  let count = 0;
  for (let i = i0 + 1; i <= i1; i++) {
    const a = Math.abs(y[i]);
    if (a > thr && a >= Math.abs(y[i - 1]) && a >= Math.abs(y[i + 1])) count++;
  }
  return count / (t1 - t0);
}

/**
 * 无离散重复:2ms 平滑能量包络 → dB → 去线性趋势 → 归一化自相关,
 * 返回滞后 [lagMin,lagMax] 内最大 |ρ|(存在 flutter/离散重复时会在环周期处出峰)
 */
function maxEnvelopeAutocorr(
  y: Float64Array,
  fs: number,
  winStart: number,
  winLen: number,
  lagMin: number,
  lagMax: number,
): number {
  const k = 1 - Math.exp(-1 / (0.002 * fs));
  const i0 = Math.round(winStart * fs);
  const N = Math.round(winLen * fs);
  const envDb = new Float64Array(N);
  let e = 0;
  for (let i = 0; i < i0 + N; i++) {
    e += k * (y[i] * y[i] - e);
    if (i >= i0) envDb[i - i0] = 10 * Math.log10(Math.max(e, 1e-30));
  }
  // 去线性趋势(指数衰减本身是一条直线,不是"重复")
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < N; i++) {
    sx += i;
    sy += envDb[i];
    sxx += i * i;
    sxy += i * envDb[i];
  }
  const b = (N * sxy - sx * sy) / (N * sxx - sx * sx);
  const a = (sy - b * sx) / N;
  const r = new Float64Array(N);
  let var0 = 0;
  for (let i = 0; i < N; i++) {
    r[i] = envDb[i] - (a + b * i);
    var0 += r[i] * r[i];
  }
  let maxR = 0;
  for (let lag = Math.round(lagMin * fs); lag <= Math.round(lagMax * fs); lag += 2) {
    let acc = 0;
    for (let i = 0; i + lag < N; i++) acc += r[i] * r[i + lag];
    const rho = Math.abs(acc) / var0;
    if (rho > maxR) maxR = rho;
  }
  return maxR;
}

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}: ${detail}`);
  if (!ok) failures++;
}

// ---------- L0 数值健康 ----------
console.log('L0 数值健康');
{
  // 最坏增益工况:TIME=6s、DAMP=0(无损环)、MIX=100%,满幅 1kHz 正弦 3s
  const r = makeReverb({ time: 6, damp: 0, mix: 1 }, FS);
  let nan = 0, maxAbs = 0;
  for (let i = 0; i < FS * 3; i++) {
    const out = r.process(Math.sin((2 * Math.PI * 1000 * i) / FS));
    if (!Number.isFinite(out)) nan++;
    if (Math.abs(out) > maxAbs) maxAbs = Math.abs(out);
  }
  check('无 NaN', nan === 0, `nan=${nan}`);
  check('输出有界(满幅正弦,最长衰减)', maxAbs < 10, `maxAbs=${maxAbs.toFixed(2)}`);

  // 静音→静音(零状态 + 零输入,线性系统应精确为 0)
  const r2 = makeReverb({ mix: 1 }, FS);
  let silentMax = 0;
  for (let i = 0; i < FS; i++) silentMax = Math.max(silentMax, Math.abs(r2.process(0)));
  check('静音→静音', silentMax < 1e-12, `silentMax=${silentMax.toExponential(1)}`);

  // 无极限环:脉冲后 6s,末端应衰减到本底下
  const r3 = makeReverb({ time: 0.5, mix: 1 }, FS);
  r3.process(1);
  let tailMax = 0;
  for (let i = 0; i < FS * 6; i++) {
    const out = Math.abs(r3.process(0));
    if (i >= FS * 5) tailMax = Math.max(tailMax, out);
  }
  check('尾部衰减无极限环', tailMax < 1e-6, `tailMax(5~6s)=${tailMax.toExponential(1)}`);

  // 参数全程扫掠:每 64 样本随机跳变全行程,灌噪声
  const r4 = makeReverb({}, FS);
  let nan4 = 0, max4 = 0;
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < FS * 5; i++) {
    if (i % 64 === 0) {
      r4.setTime(0.5 + rand() * 5.5);
      r4.setDamp(rand());
      r4.setPreDelayMs(rand() * 100);
      r4.setMix(rand());
    }
    const out = r4.process((rand() * 2 - 1) * 0.8);
    if (!Number.isFinite(out)) nan4++;
    if (Math.abs(out) > max4) max4 = Math.abs(out);
  }
  check('参数全程扫掠:无 NaN', nan4 === 0, `nan=${nan4}`);
  check('参数全程扫掠:有界', max4 < 10, `maxAbs=${max4.toFixed(2)}`);

  // 湿声电平参考(MIX=100% 脉冲响应)
  const ir = impulseIR({ time: 2.5, mix: 1 }, 3);
  let peak = 0, energy = 0;
  for (const v of ir) {
    peak = Math.max(peak, Math.abs(v));
    energy += v * v;
  }
  console.log(`  · 湿声 IR 参考(TIME=2.5s): peak=${peak.toFixed(3)} energy=${energy.toFixed(2)}`);

  // worklet ?raw 装配串与 dsp.js 参考逐样本一致(ADR-0003 后两侧同源于
  // plateReverb.dsp.js,此处验证装配/wrapper 路径无漂移,见 docs/wdf-whitebox-process.md §5)
  {
    const { ctor: Proc } = extractAssembledProcessor(
      fileURLToPath(new URL('../src/audio/wdf/plateWorklet.ts', import.meta.url)),
      buildProcessorSource,
    );
    const proc = new Proc();
    const ref = makeReverb({ time: 2.5, damp: 0.4, preDelay: 10, mix: 1, variant: 0 }, FS);
    const params = { time: [2.5], damp: [40], preDelay: [10], mix: [100] };
    let maxDiff = 0;
    const inp = [new Float32Array(128)];
    const out = [new Float32Array(128)];
    for (let blk = 0; blk < 100; blk++) {
      inp[0].fill(0);
      if (blk === 0) inp[0][0] = 1;
      proc.process([inp], [out], params);
      for (let i = 0; i < 128; i++) {
        const r = ref.process(blk === 0 && i === 0 ? 1 : 0);
        maxDiff = Math.max(maxDiff, Math.abs(out[0][i] - r));
      }
    }
    check('worklet 装配串与 dsp.js 逐样本一致', maxDiff < 1e-7, `maxDiff=${maxDiff.toExponential(1)}(100 块)`);
  }
}

// ---------- L1 特征指标 ----------
console.log('L1 特征指标');
{
  // RT60 = TIME ±15%(DAMP=0 无损环,48kHz 全行程 9 点)
  const times = [0.5, 0.7, 1, 1.5, 2, 3, 4, 5, 6];
  const rt60s = times.map((t) => rt60T30(impulseIR({ time: t, damp: 0, mix: 1 }, t * 1.3 + 1), FS));
  const okRt = times.every((t, i) => Math.abs(rt60s[i] - t) / t <= 0.15);
  check(
    'RT60 随 TIME ±15%(48kHz 全行程)',
    okRt,
    times.map((t, i) => `${t}s→${rt60s[i].toFixed(2)}(${(((rt60s[i] - t) / t) * 100).toFixed(1)}%)`).join(' '),
  );

  // 采样率 × variant 抽查(长度表随 fs 缩放,各处都应准确)
  {
    const spots: string[] = [];
    let okSpot = true;
    for (const fs of [44100, 96000]) {
      for (const variant of [0, 1] as const) {
        for (const t of [0.5, 3, 6]) {
          const rt = rt60T30(impulseIR({ time: t, damp: 0, mix: 1, variant }, t * 1.3 + 1, fs), fs);
          const err = (rt - t) / t;
          if (Math.abs(err) > 0.15) okSpot = false;
          spots.push(`${fs / 1000}k-v${variant}-${t}s:${rt.toFixed(2)}(${(err * 100).toFixed(1)}%)`);
        }
      }
    }
    check('RT60 ±15%(44.1k/96kHz × 双 variant)', okSpot, spots.join(' '));
  }

  // 默认 DAMP 下 1kHz 中带 RT60 仍 ≈ TIME(阻尼只影响高频)
  const irD = impulseIR({ time: 3, damp: 0.4, mix: 1 }, 5);
  const rt1k = rt60T30(filterBiquad(irD, bandpass(FS, 1000, 1.2)), FS);
  check('1kHz 中带 RT60 ≈ TIME ±15%(默认 DAMP)', Math.abs(rt1k - 3) / 3 <= 0.15, `rt1k=${rt1k.toFixed(2)}s`);

  // 衰减平滑指数(TIME=2.5s,EDC [-5,-45]dB 线性拟合)
  const irS = impulseIR({ time: 2.5, damp: 0.4, mix: 1 }, 4.5);
  const { db, i0, i1, slope, intercept } = edcLine(irS, FS, -5, -45);
  let ssRes = 0, ssTot = 0, mean = 0, maxRes = 0;
  for (let i = i0; i < i1; i++) mean += db[i];
  mean /= i1 - i0;
  for (let i = i0; i < i1; i++) {
    const fit = slope * (i / FS) + intercept;
    ssRes += (db[i] - fit) ** 2;
    ssTot += (db[i] - mean) ** 2;
    maxRes = Math.max(maxRes, Math.abs(db[i] - fit));
  }
  const r2 = 1 - ssRes / ssTot;
  check('衰减平滑指数(R²≥0.995)', r2 >= 0.995, `R²=${r2.toFixed(5)} maxRes=${maxRes.toFixed(2)}dB`);
  check('衰减无台阶/无回凸(残差<1.5dB)', maxRes < 1.5, `maxRes=${maxRes.toFixed(2)}dB`);

  // PREDELAY 首达时间
  const ir0 = impulseIR({ preDelay: 0, mix: 1 }, 1);
  const iFirst0 = firstAbove(ir0, 1e-6);
  const t0 = iFirst0 / FS;
  let lead0Max = 0;
  for (let i = 0; i < iFirst0; i++) lead0Max = Math.max(lead0Max, Math.abs(ir0[i]));
  check(
    '首达 = 固定扩散延迟(5~20ms)且之前零泄漏',
    t0 > 0.005 && t0 < 0.02 && lead0Max < 1e-9,
    `t0=${(t0 * 1000).toFixed(2)}ms leadMax=${lead0Max.toExponential(1)}`,
  );
  for (const pd of [25, 100]) {
    const irP = impulseIR({ preDelay: pd, mix: 1 }, 1);
    const tP = firstAbove(irP, 1e-6) / FS;
    const err = Math.abs(tP - t0 - pd / 1000) * 1000;
    // 预延迟生效前零泄漏
    const lead = Math.round((pd / 1000 + t0) * FS) - Math.round(0.002 * FS);
    let leak = 0;
    for (let i = 0; i < lead; i++) leak = Math.max(leak, Math.abs(irP[i]));
    check(`PREDELAY=${pd}ms 首达 ±1.5ms 且前置零泄漏`, err <= 1.5 && leak < 1e-9, `t=${(tP * 1000).toFixed(2)}ms err=${err.toFixed(2)}ms leak=${leak.toExponential(1)}`);
  }

  // MIX 等功率交叉
  const irM0 = impulseIR({ mix: 0 }, 0.5);
  let m0Max = 0;
  for (let i = 1; i < irM0.length; i++) m0Max = Math.max(m0Max, Math.abs(irM0[i]));
  check('MIX=0 全干(湿声精确为 0)', Math.abs(irM0[0] - 1) < 1e-12 && m0Max < 1e-12, `out[0]=${irM0[0]} tail=${m0Max.toExponential(1)}`);
  const irM100 = impulseIR({ mix: 1 }, 3);
  check('MIX=100 全湿(冲激干声 ≈0)', Math.abs(irM100[0]) < 1e-6, `out[0]=${Math.abs(irM100[0]).toExponential(1)}`);
  const tailEnergy = (y: Float64Array) => {
    let e = 0;
    for (let i = Math.round(0.05 * FS); i < y.length; i++) e += y[i] * y[i];
    return e;
  };
  const irM50 = impulseIR({ mix: 0.5 }, 3);
  const ratio = tailEnergy(irM50) / tailEnergy(irM100);
  check('MIX=50 湿能量 = sin²(π/4) = 0.5', Math.abs(ratio - 0.5) < 0.01, `ratio=${ratio.toFixed(4)}`);
}

// ---------- L2 行为特征 ----------
console.log('L2 行为特征');
{
  const ir = impulseIR({ time: 2.5, damp: 0.4, mix: 1 }, 4);
  const density = echoDensity(ir, FS, 0.005, 0.105, -40);
  check('早期反射密度 ≥ 1000/s(前 100ms)', density >= 1000, `density=${density.toFixed(0)}/s`);

  const irF = impulseIR({ time: 2, damp: 0.4, mix: 1 }, 3.5);
  const ac = maxEnvelopeAutocorr(irF, FS, 0.4, 0.5, 0.03, 0.5);
  check('无离散重复(去趋势包络自相关 <0.35)', ac < 0.35, `maxAutocorr=${ac.toFixed(3)}`);

  // 频率相关衰减(TIME=3s)
  const bands = [250, 1000, 8000];
  const rtAt = (damp: number) =>
    bands.map((f) => rt60T30(filterBiquad(impulseIR({ time: 3, damp, mix: 1 }, 5), bandpass(FS, f, 1.2)), FS));
  const flat = rtAt(0);
  const okFlat = flat.every((rt) => Math.abs(rt - 3) / 3 <= 0.12);
  check(
    'DAMP=0 全频带 RT60 一致 ±12%',
    okFlat,
    bands.map((f, i) => `${f}Hz:${flat[i].toFixed(2)}s`).join(' '),
  );
  const damped = rtAt(1);
  const okDamp = damped[2] < 0.65 * damped[1] && Math.abs(damped[1] - 3) / 3 <= 0.15;
  check(
    'DAMP=100 高频衰减快于中频(8k < 0.65×1k)',
    okDamp,
    bands.map((f, i) => `${f}Hz:${damped[i].toFixed(2)}s`).join(' ') + ` ratio=${(damped[2] / damped[1]).toFixed(2)}`,
  );
  const mono = [0, 0.33, 0.66, 1].map((d) => rt60T30(filterBiquad(impulseIR({ time: 3, damp: d, mix: 1 }, 5), bandpass(FS, 8000, 1.2)), FS));
  const okMono = mono.every((v, i) => i === 0 || v <= mono[i - 1] * 1.02);
  check('8kHz RT60 随 DAMP 单调下降', okMono, mono.map((v) => v.toFixed(2)).join(' → '));

  // 立体声去相关
  const irL = impulseIR({ time: 2, damp: 0.4, mix: 1, variant: 0 }, 2);
  const irR = impulseIR({ time: 2, damp: 0.4, mix: 1, variant: 1 }, 2);
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < irL.length; i++) {
    sab += irL[i] * irR[i];
    saa += irL[i] * irL[i];
    sbb += irR[i] * irR[i];
  }
  const cc = Math.abs(sab) / Math.sqrt(saa * sbb);
  check('立体声 variant 去相关(互相关 <0.2)', cc < 0.2, `cc=${cc.toFixed(4)}`);

  // variant 1 的 RT60 同样准确
  const rtV1 = rt60T30(impulseIR({ time: 2, damp: 0, mix: 1, variant: 1 }, 4), FS);
  check('variant 1 RT60 = TIME ±15%', Math.abs(rtV1 - 2) / 2 <= 0.15, `rt60=${rtV1.toFixed(2)}s`);
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项未过 ✗`);
if (failures > 0) process.exit(1);
