/**
 * WDF JC-120(全固态极致清音)正确性评测(L0~L3,Node 直跑:node scripts/wdf-jc120-eval.ts)
 *
 * 对照基准:Roland JC-120 电路性格——
 *   运放线性前级(极端输入才软削)+ 超大余量固态后级(深度 tanh 兜底)
 *   + 扬声器带宽(50Hz HP / 8kHz LP)+ 0.45Hz 三角 LFO 立体声合唱。
 * 性格要求:静态 THD 极低、玻璃感平直中频、大输入不削波区 + 边缘压缩区分明。
 *
 * 测量规范:≥0.5s 建立期(§4.2);Goertzel 测频一律取采样窗整数周期(§4.3)。
 * 注:全链非线性为显式无记忆 tanh(串联无反馈),无隐式 Newton 求解器,
 *     故 L0 以 NaN/有界/静音不动点为健康判据,无迭代数统计。
 */
import {
  JC120,
  Jc120Core,
  Jc120Chorus,
  jc120Drive,
  jc120Nonlin,
} from '../src/audio/wdf/jc120Core.ts';
import {
  makeAntiAliasFIR,
  Upsampler4x,
  Decimator4x,
  OS_FACTOR,
} from '../src/audio/wdf/resample.ts';

const BASE = 48000;
const FS = BASE * OS_FACTOR;
const SETTLE = BASE / 2; // 0.5s 建立期

/** 与 worklet 同构的完整链(4x 重采样 + 清音核心 + 基率合唱) */
function makeChain(gainPct: number, chorusOn = false) {
  const core = new Jc120Core(FS);
  core.setGain(gainPct);
  const chorus = new Jc120Chorus(BASE);
  chorus.setOn(chorusOn ? 1 : 0);
  const fir = makeAntiAliasFIR();
  const up = new Upsampler4x(fir);
  const down = new Decimator4x(fir);
  const osBuf = new Float32Array(OS_FACTOR);
  const osOut = new Float32Array(OS_FACTOR);
  return {
    process(x: number): number {
      up.process(osBuf, x);
      for (let k = 0; k < OS_FACTOR; k++) osOut[k] = core.processOs(osBuf[k]);
      return chorus.process(down.process(osOut[0], osOut[1], osOut[2], osOut[3]));
    },
  };
}

/** 建立 0.5s 后采集 n 个样本(n 须为 freq 整周期) */
function settleAndCapture(
  chain: { process(x: number): number },
  freq: number,
  amp: number,
  n: number,
): Float64Array {
  for (let i = 0; i < SETTLE; i++) chain.process(amp * Math.sin((2 * Math.PI * freq * i) / BASE));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = chain.process(amp * Math.sin((2 * Math.PI * freq * (i + SETTLE)) / BASE));
  }
  return out;
}

/** freq 整除 BASE 时的整周期窗长(≥minN) */
function cycleLen(freq: number, minN: number): number {
  const per = BASE / freq;
  if (!Number.isInteger(per)) throw new Error(`freq ${freq} 不整除 ${BASE}`);
  return per * Math.max(1, Math.ceil(minN / per));
}

/** 单频点复幅度(Goertzel,整周期窗 = DFT 单 bin) */
function goertzelC(y: ArrayLike<number>, freq: number): { re: number; im: number } {
  const N = y.length;
  const w = (2 * Math.PI * freq) / BASE;
  let re = 0, im = 0;
  for (let n = 0; n < N; n++) {
    re += y[n] * Math.cos(w * n);
    im -= y[n] * Math.sin(w * n);
  }
  return { re: (2 * re) / N, im: (2 * im) / N };
}

function goertzel(y: ArrayLike<number>, freq: number): number {
  const c = goertzelC(y, freq);
  return Math.hypot(c.re, c.im);
}

function thd(y: Float64Array, fund: number): { thd: number; h2h3: number } {
  const f1 = goertzel(y, fund);
  const f2 = goertzel(y, fund * 2);
  const f3 = goertzel(y, fund * 3);
  const f4 = goertzel(y, fund * 4);
  const f5 = goertzel(y, fund * 5);
  return {
    thd: Math.sqrt(f2 * f2 + f3 * f3 + f4 * f4 + f5 * f5) / f1,
    h2h3: f2 / Math.max(1e-12, f3),
  };
}

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}: ${detail}`);
  if (!ok) failures++;
}

// ---------- L0 求解器健康 ----------
console.log('L0 求解器健康(显式 tanh 链,无隐式 Newton)');
{
  const c = makeChain(100, true);
  let nan = 0, maxAbs = 0;
  for (let i = 0; i < BASE / 2; i++) {
    const out = c.process(1.0 * Math.sin((2 * Math.PI * 1000 * i) / BASE));
    if (!Number.isFinite(out)) nan++;
    maxAbs = Math.max(maxAbs, Math.abs(out));
  }
  check('无 NaN', nan === 0, `nan=${nan}`);
  check(
    '输出有界(≤ RAIL_POWER/NORM≈2.08)',
    maxAbs < 2.2,
    `maxAbs=${maxAbs.toFixed(3)}`,
  );

  for (const on of [false, true]) {
    const c2 = makeChain(100, on);
    let silentMax = 0;
    for (let i = 0; i < BASE / 10; i++) silentMax = Math.max(silentMax, Math.abs(c2.process(0)));
    check(`静音→静音(chorus=${on ? 'on' : 'off'},无极限环)`, silentMax < 1e-12, `silentMax=${silentMax.toExponential(1)}`);
  }
}

// ---------- L1 静态传输特性 ----------
console.log('L1 静态传输特性(jc120Nonlin 纯静态核,drive=20 即 GAIN=100)');
{
  const drive = jc120Drive(100);
  const linSlope = (drive * JC120.POWER_GAIN) / JC120.NORM;
  let maxJump = 0, maxAsym = 0, maxAbs = 0, monoOk = true;
  let prev = jc120Nonlin(-2, drive);
  const N = 8192;
  for (let i = 1; i <= N; i++) {
    const x = -2 + (4 * i) / N;
    const y = jc120Nonlin(x, drive);
    maxJump = Math.max(maxJump, Math.abs(y - prev));
    maxAsym = Math.max(maxAsym, Math.abs(y + jc120Nonlin(-x, drive)));
    maxAbs = Math.max(maxAbs, Math.abs(y));
    if (y < prev) monoOk = false;
    prev = y;
  }
  const slope0 = jc120Nonlin(1e-4, drive) / 1e-4;
  check('单调不减', monoOk, '');
  check('奇对称(纯 tanh 链,|f(x)+f(-x)|≈0)', maxAsym < 1e-9, `maxAsym=${maxAsym.toExponential(1)}`);
  check('传输曲线连续(无跳变)', maxJump < 0.02, `maxJump=${maxJump.toFixed(5)}`);
  check(
    `小信号斜率 = drive×2/12 = ${linSlope.toFixed(2)}(±1%)`,
    Math.abs(slope0 / linSlope - 1) < 0.01,
    `slope0=${slope0.toFixed(3)}`,
  );
  check('深度饱和有界(|f| ≤ 25/12≈2.08)', maxAbs <= JC120.RAIL_POWER / JC120.NORM + 1e-9, `maxAbs=${maxAbs.toFixed(3)}`);

  // 压缩起点:0.1V(标称 DI)仍干净,1.0V(极端输入)明显压缩
  const compDb = (x: number) =>
    -20 * Math.log10(jc120Nonlin(x, drive) / (linSlope * x));
  const c01 = compDb(0.1), c10 = compDb(1.0);
  check('0.1V 输入近乎无压缩(<0.5dB)', c01 < 0.5, `comp=${c01.toFixed(2)}dB`);
  check('1.0V 极端输入进入软削(>3dB)', c10 > 3, `comp=${c10.toFixed(2)}dB`);
}

// ---------- L2 线性区频响 ----------
console.log('L2 小信号频响(5mV,gain=40,全链基率;扬声器 50Hz HP + 8kHz LP 性格)');
{
  const amp = 5e-3;
  const gainAt = (freq: number) => {
    const chain = makeChain(40);
    const y = settleAndCapture(chain, freq, amp, cycleLen(freq, 4800));
    return goertzel(y, freq) / amp;
  };
  const freqs = [20, 40, 100, 200, 400, 1000, 2000, 4000, 6000, 8000, 12000];
  const g = new Map(freqs.map((f) => [f, gainAt(f)]));
  const db = (v: number) => 20 * Math.log10(v);
  const g1k = g.get(1000)!;
  console.log(
    `    行程(dB rel 1kHz): ${freqs.map((f) => `${f}Hz:${(db(g.get(f)!) - db(g1k)).toFixed(1)}`).join(' ')}`,
  );
  const gPred = (jc120Drive(40) * JC120.POWER_GAIN) / JC120.NORM;
  check(
    `1kHz 小信号增益 ≈ 设计值 ${gPred.toFixed(2)}(±10%)`,
    Math.abs(g1k / gPred - 1) < 0.1,
    `g1k=${g1k.toFixed(3)}`,
  );
  const flat = [200, 400, 2000].every((f) => Math.abs(db(g.get(f)!) - db(g1k)) < 1);
  check('中频平直 200Hz~2kHz(±1dB,玻璃感)', flat, '');
  const d4k = db(g1k) - db(g.get(4000)!);
  check('4kHz 轻微滚降(0~2.5dB,8kHz LP 设计值)', d4k >= 0 && d4k < 2.5, `${d4k.toFixed(1)}dB`);
  const d100 = db(g1k) - db(g.get(100)!);
  check('100Hz 扬声器 HP 衰减轻微(1~5dB)', d100 > 1 && d100 < 5, `${d100.toFixed(1)}dB`);
  const d20 = db(g1k) - db(g.get(20)!);
  check('20Hz 深度衰减(≥9dB)', d20 >= 9, `${d20.toFixed(1)}dB`);
  const d12k = db(g1k) - db(g.get(12000)!);
  check('12kHz 扬声器 LP 衰减(≥2dB)', d12k >= 2, `${d12k.toFixed(1)}dB`);
}

// ---------- L3 非线性行为 ----------
console.log('L3 非线性行为(清音核心:动态余量两个区间的量化)');
{
  // 基线小信号增益(5mV),用于压缩量测量
  const baseGainAt = (gainPct: number) => {
    const y = settleAndCapture(makeChain(gainPct), 1000, 5e-3, cycleLen(1000, 4800));
    return goertzel(y, 1000) / 5e-3;
  };
  const zone = (gainPct: number, amp: number) => {
    const y = settleAndCapture(makeChain(gainPct), 1000, amp, cycleLen(1000, 4800));
    const fund = goertzel(y, 1000);
    const comp = -20 * Math.log10(fund / (baseGainAt(gainPct) * amp));
    return { ...thd(y, 1000), fund, comp, peak: Math.max(...y.map(Math.abs)) };
  };

  // ① 静态 THD:50mV 中间增益档,要求极低
  const s0 = zone(40, 0.05);
  check('静态 THD 极低(50mV/gain40,<0.5%)', s0.thd < 0.005, `THD=${(s0.thd * 100).toFixed(3)}%`);

  // ② 大输入不削波区:0.3V(热双线圈全速扫弦)仍几乎无失真
  const s1 = zone(40, 0.3);
  check(
    `大输入不削波区(0.3V/gain40):THD<1% 且压缩<1dB`,
    s1.thd < 0.01 && s1.comp < 1,
    `THD=${(s1.thd * 100).toFixed(2)}% comp=${s1.comp.toFixed(2)}dB`,
  );

  // ③ 边缘压缩区:1.0V 满增益,平滑软削、有界、奇谐波主导
  const s2 = zone(100, 1.0);
  check(
    '边缘压缩区(1.0V/gain100):THD 1%~20%,压缩>3dB,有界<2.2',
    s2.thd > 0.01 && s2.thd < 0.2 && s2.comp > 3 && s2.peak < 2.2,
    `THD=${(s2.thd * 100).toFixed(1)}% comp=${s2.comp.toFixed(1)}dB peak=${s2.peak.toFixed(2)}`,
  );
  check('边缘区奇谐波主导(H2/H3 < 0.1)', s2.h2h3 < 0.1, `H2/H3=${s2.h2h3.toFixed(3)}`);

  // ④ THD 随 GAIN 单调上升(0.3V 输入)
  const thds = [10, 40, 70, 100].map((gp) => ({ gp, ...thd(settleAndCapture(makeChain(gp), 1000, 0.3, cycleLen(1000, 4800)), 1000) }));
  const mono = thds.every((t, i) => i === 0 || t.thd >= thds[i - 1].thd - 1e-9);
  check(
    'THD 随 GAIN 单调上升(0.3V)',
    mono,
    thds.map((t) => `g${t.gp}:${(t.thd * 100).toFixed(2)}%`).join(' '),
  );
}

// ---------- L3b CHORUS 段 ----------
console.log('L3b CHORUS(50Hz 载波相位摆动法:测 LFO 速率与调制深度)');
{
  // 50Hz:湿路相移 2πf·d ∈ [0.79, 2.36] rad < π,复合相位 = 湿相/2(半角公式),无卷绕
  const F = 50, HOP = 960, WIN = 1920; // 20ms 跳步,2 整周期窗(§4.3)
  const DUR = 20; // 20s → 相位轨 ~1000 点 @50Hz,DFT bin 9 ≈ 0.45Hz
  // 注意:链有状态(LFO/延迟线),必须先连续采集再离线开窗——
  // 重叠窗内重复 process 会让 LFO 被多倍速推进(已踩过:实测 0.9Hz 假象)。
  const capture = (chorusOn: boolean) => {
    const chain = makeChain(40, chorusOn);
    for (let i = 0; i < SETTLE; i++) chain.process(0.2 * Math.sin((2 * Math.PI * F * i) / BASE));
    const y = new Float64Array(DUR * BASE);
    for (let i = 0; i < y.length; i++) {
      y[i] = chain.process(0.2 * Math.sin((2 * Math.PI * F * (i + SETTLE)) / BASE));
    }
    return y;
  };
  const phaseTrack = (y: Float64Array) => {
    const pts: number[] = [];
    const w = (2 * Math.PI * F) / BASE;
    for (let s = 0; s + WIN <= y.length; s += HOP) {
      // 内联 Goertzel(直接在连续采集的数组上开窗,避免子数组拷贝)
      let re = 0, im = 0;
      for (let n = 0; n < WIN; n++) {
        re += y[s + n] * Math.cos(w * n);
        im -= y[s + n] * Math.sin(w * n);
      }
      pts.push(Math.atan2(im, re));
    }
    return pts;
  };
  const detrend = (p: number[]) => {
    const m = p.reduce((a, b) => a + b, 0) / p.length;
    return p.map((v) => v - m);
  };
  const smooth = (p: number[]) =>
    p.map((_, i) => {
      const a = p[Math.max(0, i - 2)], b = p[i], c2 = p[Math.min(p.length - 1, i + 2)];
      return (a + b + c2) / 3;
    });

  const pOn = detrend(phaseTrack(capture(true)));
  // 速率:相位轨 DFT,0.2~0.8Hz 内找峰(轨采样率 = BASE/HOP = 50Hz)
  const np = pOn.length;
  const fsP = BASE / HOP;
  let bestK = 0, bestMag = 0;
  for (let k = 1; k < np / 2; k++) {
    const f = (k * fsP) / np;
    if (f < 0.2 || f > 0.8) continue;
    let re = 0, im = 0;
    for (let n = 0; n < np; n++) {
      re += pOn[n] * Math.cos((2 * Math.PI * k * n) / np);
      im -= pOn[n] * Math.sin((2 * Math.PI * k * n) / np);
    }
    const mag = Math.hypot(re, im);
    if (mag > bestMag) { bestMag = mag; bestK = k; }
  }
  const fPeak = (bestK * fsP) / np;
  check(
    `LFO 速率 ≈ ${JC120.CHORUS_RATE}Hz(±0.1)`,
    Math.abs(fPeak - JC120.CHORUS_RATE) <= 0.1,
    `fPeak=${fPeak.toFixed(2)}Hz`,
  );
  // 深度:复合相位摆动 range = πf·(dmax-dmin) → 深度 p-p(ms)
  const sm = smooth(pOn);
  const range = Math.max(...sm) - Math.min(...sm);
  const depthMs = (range / (Math.PI * F)) * 1000;
  const nominal = 2 * JC120.CHORUS_DEPTH_MS;
  check(
    `调制深度 ≈ ${nominal}ms p-p(±30%)`,
    Math.abs(depthMs - nominal) < nominal * 0.3,
    `depth=${depthMs.toFixed(2)}ms p-p(相位摆幅 ${range.toFixed(3)}rad)`,
  );
  const pOff = detrend(phaseTrack(capture(false)));
  const rangeOff = Math.max(...pOff) - Math.min(...pOff);
  check('CHORUS=0 无调制(相位轨平直)', rangeOff < 0.05, `range=${rangeOff.toFixed(4)}rad`);
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项未过 ✗`);
if (failures > 0) process.exit(1);
