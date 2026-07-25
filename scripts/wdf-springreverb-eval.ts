/**
 * 弹簧混响(Spring Reverb)正确性评测(L0~L2,Node 直跑:node scripts/wdf-springreverb-eval.ts)
 *
 * 判据:
 * - L0 健康:无 NaN、有界、静音→静音(无极限环)、参数全程扫掠稳定
 * - L1 特征:RT60 随 TIME 线性可控(±15%,500Hz 参考频带);湿声频谱有全通/反馈
 *   梳状峰(boing 金属感);频谱低平坦度(金属/音调化)
 * - L2 行为:衰减包络指数平滑无突变、无离散回声重复;余音随时间变暗;
 *   DWELL 增大弥散;TONE 控制高频阻尼;MIX 干湿比
 */
import { SpringReverb } from '../src/audio/wdf/springReverb.ts';

const FS = 48000;

// ---------- 基础工具 ----------

function makeTank(time = 2, dwell = 50, tone = 50): SpringReverb {
  const t = new SpringReverb({ fs: FS });
  t.setTime(time);
  t.setDwell(dwell);
  t.setTone(tone);
  return t;
}

/** 与 worklet 同构:输出 = 干路(恒 1) + 湿声 × mix/100 */
function makeChain(p: { time: number; dwell: number; tone: number; mix: number }) {
  const tank = makeTank(p.time, p.dwell, p.tone);
  const mixG = p.mix / 100;
  return {
    process(x: number): number {
      return x + mixG * tank.process(x);
    },
  };
}

/** 湿声脉冲响应(0.1s 建立期后打单位脉冲) */
function impulseResponse(tank: SpringReverb, seconds: number): Float64Array {
  for (let i = 0; i < FS / 10; i++) tank.process(0);
  const n = Math.round(seconds * FS);
  const h = new Float64Array(n);
  for (let i = 0; i < n; i++) h[i] = tank.process(i === 0 ? 1 : 0);
  return h;
}

function rms(y: Float64Array, from = 0, to = y.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += y[i] * y[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

/** 迭代基-2 FFT,返回 |X|(0..N/2),输入零填充到 2 的幂 */
function fftMag(x: Float64Array, nFft?: number): { mag: Float64Array; binHz: number } {
  let n = nFft ?? 1;
  if (!nFft) {
    n = 1;
    while (n < x.length) n *= 2;
  }
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(x.subarray(0, Math.min(x.length, n)));
  // bit-reverse
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
  const mag = new Float64Array(n / 2 + 1);
  for (let i = 0; i <= n / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
  return { mag, binHz: FS / n };
}

/** Hann 窗 */
function hann(x: Float64Array): Float64Array {
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    y[i] = x[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (x.length - 1)));
  }
  return y;
}

/**
 * Schroeder 反向积分测 RT60(-5~-35dB 段最小二乘拟合 ×2)。
 * lpFc 给定则先在 IR 上做过两级一阶低通(标准做法:按频带测 RT60,500Hz 为参考频带)。
 */
function measureRT60(h: Float64Array, lpFc?: number): { rt60: number; r2: number } {
  let y = h;
  if (lpFc !== undefined) {
    const alpha = 1 - Math.exp((-2 * Math.PI * lpFc) / FS);
    y = new Float64Array(h.length);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < h.length; i++) {
      s1 += alpha * (h[i] - s1);
      s2 += alpha * (s1 - s2);
      y[i] = s2;
    }
  }
  const n = y.length;
  const e = new Float64Array(n);
  let acc = 0;
  for (let i = n - 1; i >= 0; i--) {
    acc += y[i] * y[i];
    e[i] = acc;
  }
  const e0 = e[0];
  const lvl = (i: number) => 10 * Math.log10(Math.max(e[i], 1e-30) / e0);
  let i5 = -1, i35 = -1;
  for (let i = 0; i < n; i++) {
    if (i5 < 0 && lvl(i) <= -5) i5 = i;
    if (lvl(i) <= -35) {
      i35 = i;
      break;
    }
  }
  if (i5 < 0 || i35 < 0 || i35 - i5 < 10) return { rt60: NaN, r2: 0 };
  // 最小二乘拟合 level(dB) ~ t(s)
  let sx = 0, sy = 0, sxx = 0, sxy = 0, cnt = 0;
  for (let i = i5; i <= i35; i++) {
    const t = i / FS;
    const l = lvl(i);
    sx += t; sy += l; sxx += t * t; sxy += t * l; cnt++;
  }
  const slope = (cnt * sxy - sx * sy) / (cnt * sxx - sx * sx);
  const intercept = (sy - slope * sx) / cnt;
  // R²
  const mean = sy / cnt;
  let ssRes = 0, ssTot = 0;
  for (let i = i5; i <= i35; i++) {
    const l = lvl(i);
    const fit = slope * (i / FS) + intercept;
    ssRes += (l - fit) * (l - fit);
    ssTot += (l - mean) * (l - mean);
  }
  return { rt60: -60 / slope, r2: 1 - ssRes / Math.max(ssTot, 1e-30) };
}

/** 包络(dB):winMs RMS 窗,hopMs 步进 */
function envelopeDb(h: Float64Array, fromSec: number, toSec: number, winMs = 10, hopMs = 5) {
  const win = Math.round((winMs / 1000) * FS);
  const hop = Math.round((hopMs / 1000) * FS);
  const t: number[] = [];
  const db: number[] = [];
  for (let s = Math.round(fromSec * FS); s + win <= Math.round(toSec * FS); s += hop) {
    let acc = 0;
    for (let i = s; i < s + win; i++) acc += h[i] * h[i];
    t.push((s + win / 2) / FS);
    db.push(10 * Math.log10(Math.max(acc / win, 1e-30)));
  }
  return { t, db };
}

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}: ${detail}`);
  if (!ok) failures++;
}

// ---------- L0 健康 ----------
console.log('L0 健康(无 NaN / 有界 / 静音→静音 / 参数扫掠)');
{
  const c = makeChain({ time: 2, dwell: 50, tone: 50, mix: 30 });
  let nan = 0, maxAbs = 0;
  const n = FS * 2;
  for (let i = 0; i < n; i++) {
    const out = c.process(Math.sin((2 * Math.PI * 1000 * i) / FS));
    if (!Number.isFinite(out)) nan++;
    if (Math.abs(out) > maxAbs) maxAbs = Math.abs(out);
  }
  check('无 NaN', nan === 0, `nan=${nan}`);
  check('输出有界', maxAbs < 30, `maxAbs=${maxAbs.toFixed(2)}`);

  const t0 = makeTank();
  let silentMax = 0;
  for (let i = 0; i < FS / 2; i++) silentMax = Math.max(silentMax, Math.abs(t0.process(0)));
  check('静音→静音', silentMax < 1e-12, `silentMax=${silentMax.toExponential(1)}`);

  // 无极限环:播完 0.5s 正弦后静默 6s,最后 1s 余音应衰减到近零
  // (RT60=4s 时 5s 自然衰减 ~75dB,只考察末段,避开静默初期的合法余音)
  const t1 = makeTank(4, 80, 80);
  for (let i = 0; i < FS / 2; i++) t1.process(Math.sin((2 * Math.PI * 440 * i) / FS));
  let tailMax = 0;
  for (let i = 0; i < FS * 6; i++) {
    const v = Math.abs(t1.process(0));
    if (i >= FS * 5 && v > tailMax) tailMax = v;
  }
  check('余音衰减无极限环(末 1s < 0.01)', tailMax < 0.01, `tailMax=${tailMax.toExponential(2)}`);

  // 参数全程扫掠(每 128 样本块跳变,模拟 k-rate 最坏情况)
  const sweeps: Array<[string, number, number]> = [
    ['time', 1, 4],
    ['dwell', 0, 100],
    ['tone', 0, 100],
    ['mix', 0, 100],
  ];
  let nan2 = 0, maxAbs2 = 0;
  let blk = 0;
  const tank2 = makeTank(1, 0, 0);
  let mixNow = 0;
  const totalBlocks = Math.floor((FS * 3) / 128);
  for (let b = 0; b < totalBlocks; b++) {
    const phase = (b % 100) / 99; // 每个参数扫 100 块
    const tri = phase < 0.5 ? phase * 2 : 2 - phase * 2;
    const [key, lo, hi] = sweeps[Math.floor(b / 100) % sweeps.length];
    const v = lo + (hi - lo) * tri;
    if (key === 'time') tank2.setTime(v);
    else if (key === 'dwell') tank2.setDwell(v);
    else if (key === 'tone') tank2.setTone(v);
    else mixNow = v / 100;
    blk++;
    for (let i = 0; i < 128; i++) {
      const x = Math.sin((2 * Math.PI * 1000 * (b * 128 + i)) / FS);
      const out = x + mixNow * tank2.process(x);
      if (!Number.isFinite(out)) nan2++;
      if (Math.abs(out) > maxAbs2) maxAbs2 = Math.abs(out);
    }
  }
  check('参数全程扫掠无 NaN', nan2 === 0, `nan=${nan2} blocks=${blk}`);
  check('参数全程扫掠有界', maxAbs2 < 30, `maxAbs=${maxAbs2.toFixed(2)}`);
}

// ---------- L1 特征指标 ----------
console.log('L1 特征指标(RT60 可控 / 梳状谱 / 金属感)');
{
  // RT60 随 TIME 线性可控(500Hz 参考频带,±15%)
  const times = [1.0, 1.5, 2.0, 3.0, 4.0];
  const rows: string[] = [];
  let allOk = true;
  let mono = true;
  let prev = 0;
  for (const t of times) {
    const tank = makeTank(t, 50, 50);
    const h = impulseResponse(tank, Math.min(6, t * 1.2 + 1));
    const band = measureRT60(h, 500);
    const full = measureRT60(h);
    const err = Math.abs(band.rt60 / t - 1);
    if (!(err <= 0.15)) allOk = false;
    if (band.rt60 <= prev) mono = false;
    prev = band.rt60;
    rows.push(
      `T=${t}s→500Hz带=${band.rt60.toFixed(2)}s(${(err * 100).toFixed(1)}%) 宽带=${full.rt60.toFixed(2)}s R²=${band.r2.toFixed(3)}`,
    );
  }
  for (const r of rows) console.log(`    ${r}`);
  check('RT60 随 TIME 线性可控(500Hz 带,±15%)', allOk, '见上');
  check('RT60 随 TIME 单调递增', mono, '');

  // 梳状谱峰(boing 特征):0.5s 湿声 IR 的频谱局部峰计数
  const tank = makeTank(2, 50, 50);
  const h = impulseResponse(tank, 2);
  const seg = hann(h.subarray(0, Math.round(0.5 * FS)));
  const { mag, binHz } = fftMag(seg, 32768);
  const db = mag.map((v) => 20 * Math.log10(Math.max(v, 1e-12)));
  const countPeaks = (fLo: number, fHi: number) => {
    const kLo = Math.ceil(fLo / binHz);
    const kHi = Math.floor(fHi / binHz);
    const W = 5;
    let cnt = 0;
    const spacings: number[] = [];
    let lastK = -1;
    for (let k = Math.max(kLo, W); k <= Math.min(kHi, db.length - 1 - W); k++) {
      if (db[k] <= db[k - 1] || db[k] < db[k + 1]) continue;
      let mean = 0;
      for (let w = -W; w <= W; w++) mean += db[k + w];
      mean /= 2 * W + 1;
      if (db[k] - mean >= 3) {
        cnt++;
        if (lastK > 0) spacings.push((k - lastK) * binHz);
        lastK = k;
      }
    }
    spacings.sort((a, b) => a - b);
    return { cnt, med: spacings.length ? spacings[Math.floor(spacings.length / 2)] : 0 };
  };
  const pAll = countPeaks(300, 3000);
  const pLo = countPeaks(300, 1500);
  const pHi = countPeaks(1500, 3000);
  check(
    '频谱梳状峰(boing,300~3000Hz ≥ 40 个显著峰)',
    pAll.cnt >= 40 && pLo.cnt >= 15 && pHi.cnt >= 15,
    `峰数=${pAll.cnt}(低${pLo.cnt}/高${pHi.cnt}) 中位间隔=${pAll.med.toFixed(1)}Hz`,
  );

  // 频谱平坦度(金属/音调化 → SFM 低)
  const seg2 = hann(h.subarray(Math.round(0.1 * FS), Math.round(0.6 * FS)));
  const { mag: mag2, binHz: binHz2 } = fftMag(seg2, 16384);
  let logSum = 0, arith = 0, nb = 0;
  for (let k = Math.ceil(200 / binHz2); k <= Math.floor(6000 / binHz2); k++) {
    const p = mag2[k] * mag2[k];
    logSum += Math.log(Math.max(p, 1e-24));
    arith += p;
    nb++;
  }
  const sfm = Math.exp(logSum / nb) / (arith / nb);
  check('频谱金属感(谱平坦度 SFM < 0.25)', sfm < 0.25, `SFM=${sfm.toFixed(3)}`);
}

// ---------- L2 行为特征 ----------
console.log('L2 行为特征(包络 / 变暗 / DWELL / TONE / MIX)');
{
  // 衰减包络指数平滑:Schroeder 衰减曲线(-5~-35dB 段)线性度
  // (预弥散前的离散回声设计此项 R² 明显变差,判据区分度高)
  const tank = makeTank(2, 50, 50);
  const h = impulseResponse(tank, 2.5);
  const schFull = measureRT60(h);
  const schBand = measureRT60(h, 500);
  check(
    '衰减包络指数平滑(500Hz 带 R² ≥ 0.995,宽带 R² ≥ 0.99)',
    schBand.r2 >= 0.995 && schFull.r2 >= 0.99,
    `bandR²=${schBand.r2.toFixed(4)} fullR²=${schFull.r2.toFixed(4)}`,
  );

  // 包络无突变 / 无离散回声重复(20ms RMS 窗、10ms 步进):
  // 窗间跳变 ≤ 4dB(实测 3.0dB;无预弥散的离散回声设计实测 6~8dB);
  // 局部尖峰(高于 ±30ms 邻域中位数)≤ 4dB(实测 2.2dB,离散回声会产生孤立尖峰)
  const envFull = envelopeDb(h, 0.04, 1.6, 20, 10);
  let maxJump = 0;
  for (let i = 1; i < envFull.db.length; i++) {
    maxJump = Math.max(maxJump, Math.abs(envFull.db[i] - envFull.db[i - 1]));
  }
  check('包络无突变(窗间跳变 ≤ 4dB)', maxJump <= 4, `maxJump=${maxJump.toFixed(2)}dB`);
  let maxSpike = 0;
  for (let i = 3; i < envFull.db.length - 3; i++) {
    if (envFull.t[i] < 0.1) continue; // 首反射团建立段除外(见 dbg:40~100ms 为平滑爬升)
    const nb = [
      envFull.db[i - 3], envFull.db[i - 2], envFull.db[i - 1],
      envFull.db[i + 1], envFull.db[i + 2], envFull.db[i + 3],
    ].sort((a, b) => a - b);
    const med = (nb[2] + nb[3]) / 2;
    maxSpike = Math.max(maxSpike, envFull.db[i] - med);
  }
  check('无离散回声重复(局部尖峰 ≤ 4dB)', maxSpike <= 4, `maxSpike=+${maxSpike.toFixed(2)}dB`);

  // 余音随时间变暗:谱质心后段 < 前段
  const centroid = (from: number, to: number) => {
    const seg = hann(h.subarray(Math.round(from * FS), Math.round(to * FS)));
    const { mag, binHz } = fftMag(seg, 16384);
    let num = 0, den = 0;
    for (let k = Math.ceil(100 / binHz); k <= Math.floor(8000 / binHz); k++) {
      const p = mag[k] * mag[k];
      num += k * binHz * p;
      den += p;
    }
    return num / Math.max(den, 1e-30);
  };
  const cEarly = centroid(0.05, 0.25);
  const cLate = centroid(0.6, 1.2);
  check(
    '余音随时间变暗(后段质心 ≤ 前段 80%)',
    cLate <= 0.8 * cEarly,
    `早期=${cEarly.toFixed(0)}Hz 晚期=${cLate.toFixed(0)}Hz 比=${(cLate / cEarly).toFixed(2)}`,
  );

  // DWELL:色散强度 → 首反射峰被涂抹变矮
  const hD0 = impulseResponse(makeTank(2, 0, 50), 0.4);
  const hD100 = impulseResponse(makeTank(2, 100, 50), 0.4);
  const peakIn = (y: Float64Array) => {
    let m = 0;
    for (let i = Math.round(0.015 * FS); i < Math.round(0.15 * FS); i++) m = Math.max(m, Math.abs(y[i]));
    return m;
  };
  const p0 = peakIn(hD0);
  const p100 = peakIn(hD100);
  check(
    'DWELL 增大弥散(首反射峰 dwell100 ≤ 0.7×dwell0)',
    p100 <= 0.7 * p0,
    `dwell0=${p0.toFixed(3)} dwell100=${p100.toFixed(3)} 比=${(p100 / p0).toFixed(2)}`,
  );

  // TONE:高频阻尼可控(HF/LF 能量比单调)
  const bandRatio = (tone: number) => {
    const hh = impulseResponse(makeTank(2, 50, tone), 1);
    const seg = hann(hh.subarray(Math.round(0.05 * FS), Math.round(0.5 * FS)));
    const { mag, binHz } = fftMag(seg, 16384);
    const bandPow = (fLo: number, fHi: number) => {
      let s = 0;
      for (let k = Math.ceil(fLo / binHz); k <= Math.floor(fHi / binHz); k++) s += mag[k] * mag[k];
      return s;
    };
    return bandPow(2000, 6000) / bandPow(150, 800);
  };
  const r0 = bandRatio(0);
  const r50 = bandRatio(50);
  const r100 = bandRatio(100);
  check(
    'TONE 高频阻尼可控(HF/LF 比单调,100/0 ≥ 3)',
    r0 < r50 && r50 < r100 && r100 / r0 >= 3,
    `tone0=${r0.toFixed(3)} tone50=${r50.toFixed(3)} tone100=${r100.toFixed(3)} 跨距=${(r100 / r0).toFixed(1)}×`,
  );

  // MIX:mix=0 干路比特透传;湿声电平随 mix 单调
  const chain0 = makeChain({ time: 2, dwell: 50, tone: 50, mix: 0 });
  let maxDiff = 0;
  for (let i = 0; i < FS / 2; i++) {
    const x = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / FS);
    maxDiff = Math.max(maxDiff, Math.abs(chain0.process(x) - x));
  }
  check('MIX=0 干路比特透传', maxDiff === 0, `maxDiff=${maxDiff.toExponential(1)}`);
  const wetRms = (mix: number) => {
    const c = makeChain({ time: 2, dwell: 50, tone: 50, mix });
    const n = FS;
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const x = i === 0 ? 1 : 0;
      y[i] = c.process(x) - x; // 扣除干路得湿声
    }
    return rms(y);
  };
  const w25 = wetRms(25);
  const w50 = wetRms(50);
  const w100 = wetRms(100);
  check(
    'MIX 湿声电平单调(25<50<100)',
    w25 < w50 && w50 < w100 && w25 > 0,
    `mix25=${w25.toFixed(4)} mix50=${w50.toFixed(4)} mix100=${w100.toFixed(4)}`,
  );
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项未过 ✗`);
if (failures > 0) process.exit(1);
