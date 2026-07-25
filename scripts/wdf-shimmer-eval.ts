/**
 * 微光混响(Shimmer Reverb)正确性评测(L0~L2,Node 直跑:node scripts/wdf-shimmer-eval.ts)
 *
 * 判据:
 *  L0 健康:无 NaN、有界、静音→静音、参数全程扫掠稳定
 *  L1 特征:RT60 准确可控(TIME 2~8s,中频带限 EDC 法);尾音 +1 八度成分显著,
 *          且八度能量峰值/质心精确落在 2f0;基板混响(shimmer=0)衰减平滑;
 *          shimmer 全开尾音仍有界衰减
 *  L2 行为:SHIMMER 单调控制八度能量;八度级联份额随尾音时间上升(星空感);
 *          4f0 级联可测;DAMP 加速高频衰减;TIME 控制尾音长度;
 *          MIX 干湿正确;双声道去相关
 *
 * 测量纪律(见 docs/wdf-whitebox-process.md §4):
 *  - 频谱分析窗一律取分析频率整数周期:0.2s 窗 = 5Hz 分辨率,
 *    400/500/700~900(step20)/1600/3200/4000Hz 全部整数周期;
 *  - RT60 用倍频程带限(350~700Hz)冲激响应 + Schroeder 反向积分(-5~-35dB 段),
 *    避免宽带 IR 中高频快衰污染拟合(模型 damp=0 仍有 10kHz 环内 LP)。
 */
import { ShimmerReverb } from '../src/audio/wdf/shimmerReverb.ts';

const FS = 48000;
/** 分析窗:0.2s = 9600 样本,5Hz 分辨率 */
const WIN = 9600;

interface Params {
  time: number;
  shimmer: number;
  damp: number;
  mix: number;
  channel?: number;
}

function makeChain(p: Params): ShimmerReverb {
  const c = new ShimmerReverb({ fs: FS, channel: p.channel ?? 0 });
  c.setTime(p.time);
  c.setShimmer(p.shimmer);
  c.setDamp(p.damp);
  c.setMix(p.mix);
  return c;
}

/** 单/双频正弦爆发 + 静音尾,返回全程输出 */
function runBurst(
  p: Params,
  freqs: number[],
  amp: number,
  burstSec: number,
  tailSec: number,
): Float64Array {
  const c = makeChain(p);
  const n0 = Math.round(burstSec * FS);
  const n1 = Math.round(tailSec * FS);
  const out = new Float64Array(n0 + n1);
  for (let i = 0; i < n0; i++) {
    let x = 0;
    for (const f of freqs) x += (amp / freqs.length) * Math.sin((2 * Math.PI * f * i) / FS);
    out[i] = c.process(x);
  }
  for (let i = 0; i < n1; i++) out[n0 + i] = c.process(0);
  return out;
}

/** 冲激响应 */
function runImpulse(p: Params, amp: number, sec: number): Float64Array {
  const c = makeChain(p);
  const n = Math.round(sec * FS);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = c.process(i === 0 ? amp : 0);
  return out;
}

/** 单频点幅度(Goertzel);freq 须在 n 窗内整数周期 */
function goertzel(y: Float64Array, offset: number, freq: number, n: number): number {
  const w = (2 * Math.PI * freq) / FS;
  let re = 0, im = 0;
  for (let k = 0; k < n; k++) {
    re += y[offset + k] * Math.cos(w * k);
    im -= y[offset + k] * Math.sin(w * k);
  }
  return (2 * Math.hypot(re, im)) / n;
}

function rms(y: Float64Array, offset: number, n: number): number {
  let s = 0;
  for (let k = 0; k < n; k++) s += y[offset + k] * y[offset + k];
  return Math.sqrt(s / n);
}

function bandEnergyDb(y: Float64Array, offset: number, n: number): number {
  return 20 * Math.log10(Math.max(1e-12, rms(y, offset, n)));
}

/** 倍频程带通(一阶 HP@350 ×2 + 一阶 LP@700 ×2),测 500Hz 区 RT60 */
function bandpassMid(h: Float64Array): Float64Array {
  const T = 1 / FS;
  const aHp = T / (1 / (2 * Math.PI * 350) + T);
  const aLp = T / (1 / (2 * Math.PI * 700) + T);
  const out = new Float64Array(h.length);
  let lp1 = 0, lp2 = 0, hp1 = 0, hp2 = 0;
  for (let n = 0; n < h.length; n++) {
    const x = h[n];
    hp1 += aHp * (x - hp1);
    const y1 = x - hp1;
    hp2 += aHp * (y1 - hp2);
    const y2 = y1 - hp2;
    lp1 += aLp * (y2 - lp1);
    lp2 += aLp * (lp1 - lp2);
    out[n] = lp2;
  }
  return out;
}

/** 带限 IR + Schroeder EDC 拟合 RT60(-5~-35dB 段) */
function measureRT60Band(p: Params): { rt: number; r2: number } {
  const sec = p.time + 4;
  const h = bandpassMid(runImpulse(p, 0.5, sec));
  const hop = Math.round(0.005 * FS); // 5ms
  const bands = Math.floor(h.length / hop);
  const e = new Float64Array(bands);
  for (let b = 0; b < bands; b++) {
    let s = 0;
    for (let k = 0; k < hop; k++) s += h[b * hop + k] * h[b * hop + k];
    e[b] = s;
  }
  const edc = new Float64Array(bands);
  let acc = 0;
  for (let b = bands - 1; b >= 0; b--) {
    acc += e[b];
    edc[b] = acc;
  }
  const level = (b: number) => 10 * Math.log10(Math.max(1e-20, edc[b] / edc[0]));
  let b0 = 0;
  while (b0 < bands && level(b0) > -5) b0++;
  let b1 = b0;
  while (b1 < bands && level(b1) > -35) b1++;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let b = b0; b < b1; b++) {
    const t = (b * hop) / FS;
    sx += t;
    sy += level(b);
    sxx += t * t;
    sxy += t * level(b);
  }
  const cnt = b1 - b0;
  const slope = (cnt * sxy - sx * sy) / (cnt * sxx - sx * sx);
  // 拟合线性度 R²
  const a = (sy - slope * sx) / cnt;
  const mean = sy / cnt;
  let ssRes = 0, ssTot = 0;
  for (let b = b0; b < b1; b++) {
    const t = (b * hop) / FS;
    const r = level(b) - (a + slope * t);
    ssRes += r * r;
    ssTot += (level(b) - mean) * (level(b) - mean);
  }
  return { rt: -60 / slope, r2: 1 - ssRes / ssTot };
}

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}: ${detail}`);
  if (!ok) failures++;
}

const DEF: Params = { time: 4.5, shimmer: 40, damp: 40, mix: 100 };

// ---------- L0 健康 ----------
console.log('L0 健康');
{
  // 参数全程扫掠(含边界)+ 持续信号
  const c = makeChain({ time: 2, shimmer: 0, damp: 0, mix: 50 });
  let nan = 0, maxAbs = 0;
  const N = 3 * FS;
  for (let i = 0; i < N; i++) {
    const ph = i / N;
    c.setTime(2 + 6 * Math.abs(Math.sin(2 * Math.PI * ph)));
    c.setShimmer(100 * (ph < 0.5 ? ph * 2 : 2 - ph * 2));
    c.setDamp(100 * Math.abs(Math.sin(4 * Math.PI * ph)));
    c.setMix(100 * ph);
    const out = c.process(0.5 * Math.sin((2 * Math.PI * 220 * i) / FS));
    if (!Number.isFinite(out)) nan++;
    maxAbs = Math.max(maxAbs, Math.abs(out));
  }
  check('无 NaN(参数全程扫掠)', nan === 0, `nan=${nan}`);
  check('输出有界(maxAbs < 8)', maxAbs < 8, `maxAbs=${maxAbs.toFixed(3)}`);

  // 极端参数组合:最长混响 + 满 shimmer
  const c2 = makeChain({ time: 8, shimmer: 100, damp: 0, mix: 100 });
  let nan2 = 0, maxAbs2 = 0;
  for (let i = 0; i < 6 * FS; i++) {
    const x = i < FS / 2 ? 0.5 * Math.sin((2 * Math.PI * 330 * i) / FS) : 0;
    const out = c2.process(x);
    if (!Number.isFinite(out)) nan2++;
    maxAbs2 = Math.max(maxAbs2, Math.abs(out));
  }
  check('无 NaN(time=8/shimmer=100 极端)', nan2 === 0, `nan=${nan2}`);
  check('极端参数有界(maxAbs < 8)', maxAbs2 < 8, `maxAbs=${maxAbs2.toFixed(3)}`);

  // 静音 → 静音
  const c3 = makeChain(DEF);
  let silentMax = 0;
  for (let i = 0; i < FS; i++) silentMax = Math.max(silentMax, Math.abs(c3.process(0)));
  check('静音→静音', silentMax < 1e-12, `silentMax=${silentMax.toExponential(1)}`);
}

// ---------- L1 特征指标 ----------
console.log('L1 特征指标');
{
  // RT60 准确可控(shimmer=0 隔离基板混响,中频带限 EDC 法)
  for (const t of [2, 4.5, 8]) {
    const { rt, r2 } = measureRT60Band({ ...DEF, time: t, shimmer: 0, damp: 0 });
    const err = Math.abs(rt - t) / t;
    check(
      `RT60(${t}s)误差 < 8%`,
      err < 0.08,
      `实测 ${rt.toFixed(2)}s,误差 ${(err * 100).toFixed(1)}%(EDC 线性度 R²=${r2.toFixed(4)})`,
    );
  }

  // 尾音 +1 八度显著(400Hz 爆发,尾窗取爆发后 0.6~0.8s)
  const burstSec = 1.5;
  const tailAt = (s: number) => Math.round(burstSec * FS + s * FS);
  const y70 = runBurst({ ...DEF, shimmer: 70, damp: 20 }, [400], 0.3, burstSec, 3);
  const r70 = goertzel(y70, tailAt(0.6), 800, WIN) / goertzel(y70, tailAt(0.6), 400, WIN);
  check('尾音 +1 八度成分显著(2f0/f0 ≥ 0.25)', r70 >= 0.25, `2f0/f0=${r70.toFixed(3)}`);

  // 对照:shimmer=0 时八度成分应基本消失(线性系统,仅泄漏)
  const y0 = runBurst({ ...DEF, shimmer: 0, damp: 20 }, [400], 0.3, burstSec, 3);
  const r0 = goertzel(y0, tailAt(0.6), 800, WIN) / goertzel(y0, tailAt(0.6), 400, WIN);
  check('对照 shimmer=0 八度微弱(2f0/f0 < 0.05)', r0 < 0.05, `2f0/f0=${r0.toFixed(4)}`);

  // 八度频率精确:700~900Hz 邻域内峰值在 800,且功率质心在 ±2% 内
  {
    const freqs: number[] = [];
    for (let f = 700; f <= 900; f += 20) freqs.push(f);
    const amps = freqs.map((f) => goertzel(y70, tailAt(0.6), f, WIN));
    const peak = freqs[amps.indexOf(Math.max(...amps))];
    let num = 0, den = 0;
    for (let i = 0; i < freqs.length; i++) {
      const pw = amps[i] * amps[i];
      num += freqs[i] * pw;
      den += pw;
    }
    const centroid = num / den;
    const centsOk = Math.abs(centroid - 800) / 800 < 0.02;
    check(
      '八度频率精确(峰在 2f0 且质心 ±2%)',
      peak === 800 && centsOk,
      `peak=${peak}Hz centroid=${centroid.toFixed(1)}Hz(偏 ${(((centroid - 800) / 800) * 100).toFixed(2)}%)`,
    );
  }

  // 基板混响衰减平滑(100ms 带能量对数,0.2~1.6s,无 >1.5dB 回升)
  const h = runImpulse({ ...DEF, shimmer: 0, damp: 30 }, 0.5, 2);
  const band = Math.round(0.1 * FS);
  let maxRise = -Infinity;
  let prev = Infinity;
  for (let b = 2; b < 16; b++) {
    const lv = bandEnergyDb(h, b * band, band);
    if (prev !== Infinity) maxRise = Math.max(maxRise, lv - prev);
    prev = lv;
  }
  check('基板衰减平滑(带间回升 ≤ 1.5dB)', maxRise <= 1.5, `maxRise=${maxRise.toFixed(2)}dB`);

  // shimmer 全开尾音仍有界衰减(time=8,2×RT60 后尾能 ≥40dB 低于头部)
  const h2 = runImpulse({ time: 8, shimmer: 100, damp: 0, mix: 100 }, 0.5, 17);
  const head = bandEnergyDb(h2, 0, Math.round(0.1 * FS));
  const late = bandEnergyDb(h2, Math.round(16 * FS), Math.round(0.5 * FS));
  check(
    'shimmer 全开尾音衰减(head-late ≥ 40dB)',
    head - late >= 40,
    `head=${head.toFixed(1)}dB late=${late.toFixed(1)}dB`,
  );
}

// ---------- L2 行为特征 ----------
console.log('L2 行为特征');
{
  const burstSec = 1.5;
  const tailAt = (s: number) => Math.round(burstSec * FS + s * FS);

  // SHIMMER 单调控制八度混入量
  const ratios = [10, 30, 60, 100].map((s) => {
    const y = runBurst({ ...DEF, shimmer: s, damp: 20 }, [400], 0.3, burstSec, 2);
    return { s, r: goertzel(y, tailAt(0.6), 800, WIN) / goertzel(y, tailAt(0.6), 400, WIN) };
  });
  const mono = ratios.every((v, i) => i === 0 || v.r > ratios[i - 1].r);
  check('SHIMMER 单调控制八度能量', mono, ratios.map((v) => `s${v.s}:${v.r.toFixed(3)}`).join(' '));

  // 星空感:八度级联份额随尾音时间上升((4f0+8f0)/2f0 晚窗显著高于早窗)
  const y = runBurst({ ...DEF, shimmer: 70, damp: 10 }, [400], 0.3, burstSec, 4);
  const casc = (off: number) => {
    const g2 = goertzel(y, off, 800, WIN);
    const g4 = goertzel(y, off, 1600, WIN);
    const g8 = goertzel(y, off, 3200, WIN);
    return Math.hypot(g4, g8) / g2;
  };
  const cEarly = casc(tailAt(0.2));
  const cLate = casc(tailAt(1.6));
  check(
    '级联份额随尾音上升(晚窗 > 1.3× 早窗)',
    cLate > 1.3 * cEarly,
    `early=${cEarly.toFixed(3)} late=${cLate.toFixed(3)} (×${(cLate / cEarly).toFixed(2)})`,
  );

  // 八度级联:4f0(1600Hz)在晚窗可测
  const g4f0 = goertzel(y, tailAt(1.6), 1600, WIN);
  const gF0 = goertzel(y, tailAt(1.6), 400, WIN);
  check('八度级联 4f0 可测(4f0/f0 ≥ 0.03)', g4f0 / gF0 >= 0.03, `4f0/f0=${(g4f0 / gF0).toFixed(4)}`);

  // DAMP:高阻尼加速高频衰减(500/4000Hz 双频爆发,尾窗 1.0~1.2s)
  const dampRatio = (damp: number) => {
    const yy = runBurst({ ...DEF, shimmer: 0, damp }, [500, 4000], 0.3, burstSec, 2);
    return goertzel(yy, tailAt(1.0), 4000, WIN) / goertzel(yy, tailAt(1.0), 500, WIN);
  };
  const dr0 = dampRatio(0);
  const dr90 = dampRatio(90);
  const drop = 20 * Math.log10(dr0 / dr90);
  check(
    'DAMP 加速高频衰减(damp90 高频比低 ≥6dB)',
    drop >= 6,
    `hf/lf: damp0=${dr0.toFixed(3)} damp90=${dr90.toFixed(3)} (↓${drop.toFixed(1)}dB)`,
  );

  // TIME 控制尾音长度(1.5~2.0s 尾能,time=8 vs 2)
  const tailEnergy = (time: number) => {
    const yy = runBurst({ ...DEF, time, shimmer: 0 }, [400], 0.3, burstSec, 3);
    return bandEnergyDb(yy, tailAt(1.5), Math.round(0.5 * FS));
  };
  const te2 = tailEnergy(2);
  const te8 = tailEnergy(8);
  check('TIME 控制尾音长度(time8 尾能高 ≥10dB)', te8 - te2 >= 10, `time2=${te2.toFixed(1)}dB time8=${te8.toFixed(1)}dB`);

  // MIX:0 → 全干(输出==输入);100 → 前 18ms 无直达声(预延迟 20ms)
  {
    const cDry = makeChain({ ...DEF, mix: 0 });
    let maxDiff = 0;
    for (let i = 0; i < FS / 2; i++) {
      const x = 0.3 * Math.sin((2 * Math.PI * 400 * i) / FS);
      maxDiff = Math.max(maxDiff, Math.abs(cDry.process(x) - x));
    }
    check('MIX=0 全干(输出==输入)', maxDiff < 1e-7, `maxDiff=${maxDiff.toExponential(1)}`);

    const cWet = makeChain({ ...DEF, mix: 100 });
    let headRms = 0;
    const headN = Math.round(0.018 * FS);
    for (let i = 0; i < headN; i++) {
      const x = 0.3 * Math.sin((2 * Math.PI * 400 * i) / FS);
      const o = cWet.process(x);
      headRms += o * o;
    }
    headRms = Math.sqrt(headRms / headN);
    check('MIX=100 无直达声泄漏(前 18ms)', headRms < 1e-9, `headRms=${headRms.toExponential(1)}`);
  }

  // 双声道去相关(线长微偏调 + 变调相位错开)
  {
    const a = runBurst({ ...DEF, channel: 0 }, [400], 0.3, burstSec, 1);
    const b = runBurst({ ...DEF, channel: 1 }, [400], 0.3, burstSec, 1);
    const off = tailAt(0.2);
    let sab = 0, saa = 0, sbb = 0;
    for (let k = 0; k < WIN * 2; k++) {
      sab += a[off + k] * b[off + k];
      saa += a[off + k] * a[off + k];
      sbb += b[off + k] * b[off + k];
    }
    const corr = sab / Math.sqrt(saa * sbb);
    check('双声道尾部去相关(corr < 0.95)', Math.abs(corr) < 0.95, `corr=${corr.toFixed(3)}`);
  }
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项未过 ✗`);
if (failures > 0) process.exit(1);
