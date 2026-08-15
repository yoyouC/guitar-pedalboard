/**
 * WDF Twin Reverb 正确性评测(L0~L3,Node 直跑:node scripts/wdf-twin-eval.ts)
 * 对照基准:Fender AB763 电路性格 —
 *   大动态余量(前级几乎不削波,清音压缩主要来自 6L6 后级栅流区)、
 *   中频 scooped(voicing 500Hz -3dB)、高频晶亮(变压器 5.5kHz LP + BRIGHT 高架)、
 *   变压器 60Hz HP(低频比 Champ/Bogner 更深)。
 * 区间量化:大输入不削波区(GAIN≤50,输入 ≤150mV,THD<3%)与
 *   边缘压缩区(GAIN 75~100,输出 RMS 随输入亚线性增长)。
 */
import { TwinStage, KOREN_6L6_APPROX } from '../src/audio/wdf/twinStages.dsp.js';
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from '../src/audio/wdf/resample.dsp.js';

const BASE = 48000;
const FS = BASE * OS_FACTOR;
const T = 1 / FS;

// 与 worklet 完全一致的链常数
const ATT_PW = 0.6;
const OUT_SCALE = 250;
const volOf = (g: number) => 0.4 * Math.pow(g / 100, 2);

/** 与 worklet 同构的完整链(含 4x 重采样与输出变压器) */
function makeChain() {
  const st1 = new TwinStage(FS, { Rk: 1.5e3, Ck: 25e-6, Co: 22e-9, Rs: 34e3 });
  const st2 = new TwinStage(FS, { Rk: 1.5e3, Ck: 25e-6, Co: 22e-9, Rs: 100e3 });
  const cf = new TwinStage(FS, {
    Rp: 0, Rk: 100e3, Ck: 0, Co: 22e-9, Rs: 47e3, Vbias: 95, cathodeTap: true,
  });
  const pw = new TwinStage(FS, {
    koren: KOREN_6L6_APPROX, Bplus: 420, Rp: 2e3, Rk: 250, Ck: 0,
    Co: 1e-3, Rload: 1e6, Rs: 220e3,
  });
  const fir = makeAntiAliasFIR();
  const up = new Upsampler4x(fir);
  const down = new Decimator4x(fir);
  const osBuf = new Float32Array(OS_FACTOR);
  let hpX1 = 0, hpY1 = 0, lpY1 = 0;
  const rcHp = 1 / (2 * Math.PI * 60), aHp = rcHp / (rcHp + T);
  const rcLp = 1 / (2 * Math.PI * 5500), aLp = T / (rcLp + T);
  const stages = { st1, st2, cf, pw };
  return {
    stages,
    /** OS 域单样本,返回各探针 */
    runOs(xOs: number, g: number) {
      const s1 = st1.process(xOs);
      const s2 = st2.process(s1 * volOf(g));
      const c = cf.process(s2);
      const p = pw.process(c * ATT_PW);
      const yHp = aHp * (hpY1 + p - hpX1);
      hpX1 = p; hpY1 = yHp;
      lpY1 = lpY1 + aLp * (yHp - lpY1);
      return { outOs: lpY1 / OUT_SCALE, cfOut: c, pwOut: yHp / OUT_SCALE };
    },
    /** 基率单样本(完整 worklet 路径:升采样 → 4x OS → 降采样) */
    process(x: number, g: number): number {
      up.process(osBuf, x);
      const o: number[] = [0, 0, 0, 0];
      for (let k = 0; k < OS_FACTOR; k++) o[k] = this.runOs(osBuf[k], g).outOs;
      return down.process(o[0], o[1], o[2], o[3]);
    },
  };
}

type Chain = ReturnType<typeof makeChain>;

/** OS 域渲染(0.5s 建立),probe: out(变压器后,OS 域)/cf/pw */
function renderOs(ch: Chain, g: number, amp: number, probe: 'out' | 'cf' | 'pw', freq = 1000, settle = 0.5): Float64Array {
  const N = 8192 * OS_FACTOR;
  const nSettle = Math.floor(FS * settle);
  const y = new Float64Array(N);
  for (let i = 0; i < nSettle + N; i++) {
    const x = amp * Math.sin((2 * Math.PI * freq * i) / FS);
    const r = ch.runOs(x, g);
    if (i >= nSettle) y[i - nSettle] = probe === 'out' ? r.outOs : probe === 'cf' ? r.cfOut : r.pwOut;
  }
  return y;
}

/** 基率渲染(完整 worklet 路径,0.5s 建立,降采样器每样本都走) */
function renderBase(ch: Chain, g: number, amp: number, n: number, freq = 1000, settle = 0.5): Float64Array {
  const nSettle = Math.floor(BASE * settle);
  const y = new Float64Array(n);
  for (let i = 0; i < nSettle + n; i++) {
    const v = ch.process(amp * Math.sin((2 * Math.PI * freq * i) / BASE), g);
    if (i >= nSettle) y[i - nSettle] = v;
  }
  return y;
}

function goertzelOs(y: Float64Array, f: number): number {
  const N = y.length;
  const w = (2 * Math.PI * f) / FS;
  let re = 0, im = 0;
  for (let n = 0; n < N; n++) { re += y[n] * Math.cos(w * n); im -= y[n] * Math.sin(w * n); }
  return (2 * Math.hypot(re, im)) / N;
}
function goertzelBase(y: Float64Array, f: number): number {
  const N = y.length;
  const w = (2 * Math.PI * f) / BASE;
  let re = 0, im = 0;
  for (let n = 0; n < N; n++) { re += y[n] * Math.cos(w * n); im -= y[n] * Math.sin(w * n); }
  return (2 * Math.hypot(re, im)) / N;
}
function thdOs(y: Float64Array, f: number) {
  const f1 = goertzelOs(y, f);
  const h2 = goertzelOs(y, f * 2), h3 = goertzelOs(y, f * 3);
  const h = Math.hypot(h2, h3, goertzelOs(y, f * 4), goertzelOs(y, f * 5));
  return { thd: h / f1, h2: h2 / f1, h3: h3 / f1 };
}
function rms(y: Float64Array): number {
  let s = 0;
  for (const v of y) s += v * v;
  return Math.sqrt(s / y.length);
}

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}: ${detail}`);
  if (!ok) failures++;
}

// ---------- L0 求解器健康 ----------
console.log('L0 求解器健康(完整 worklet 路径)');
{
  const ch = makeChain();
  let nan = 0, maxAbs = 0;
  for (let i = 0; i < BASE; i++) {
    const out = ch.process(0.05 * Math.sin((2 * Math.PI * 1000 * i) / BASE), 100);
    if (!Number.isFinite(out)) nan++;
    if (i > BASE / 2) maxAbs = Math.max(maxAbs, Math.abs(out));
  }
  check('无 NaN(GAIN=100, 50mV)', nan === 0, `nan=${nan}`);
  check('输出有界(<1.5)', maxAbs < 1.5, `maxAbs=${maxAbs.toFixed(3)}`);
  const iters = (['st1', 'st2', 'cf', 'pw'] as const).map(
    (k) => `${k}=${(ch.stages[k].iterTotal / Math.max(1, ch.stages[k].iterCount)).toFixed(1)}`,
  );
  const maxIter = Math.max(
    ...(['st1', 'st2', 'cf', 'pw'] as const).map((k) => ch.stages[k].iterTotal / Math.max(1, ch.stages[k].iterCount)),
  );
  check('Newton 收敛(平均 <10 次/级)', maxIter < 10, iters.join(' '));

  // 极端输入:400mV 满增益
  const ch2 = makeChain();
  let nan2 = 0, maxAbs2 = 0;
  for (let i = 0; i < BASE; i++) {
    const out = ch2.process(0.4 * Math.sin((2 * Math.PI * 1000 * i) / BASE), 100);
    if (!Number.isFinite(out)) nan2++;
    if (i > BASE / 2) maxAbs2 = Math.max(maxAbs2, Math.abs(out));
  }
  check('无 NaN(GAIN=100, 400mV 极端)', nan2 === 0, `nan=${nan2}`);
  check('极端输出有界(<1.5)', maxAbs2 < 1.5, `maxAbs=${maxAbs2.toFixed(3)}`);

  const ch3 = makeChain();
  for (let i = 0; i < BASE * 2; i++) ch3.process(0, 80); // 2s 建立(越过开机充电瞬态)
  let silentMax = 0;
  for (let i = 0; i < BASE / 2; i++) silentMax = Math.max(silentMax, Math.abs(ch3.process(0, 80)));
  // 地板是后级 1F 耦合电容的充电斜坡经 60Hz HP 的微分响应(τ=1000s 衰减,
  // ≈-96dBFS 且持续趋零),非极限环;阈值 1e-4 仍可证无自激
  check('静音→静音(无极限环,地板 <1e-4)', silentMax < 1e-4, `silentMax=${silentMax.toExponential(1)}`);
}

// ---------- L1 静态传输特性 ----------
console.log('L1 静态传输特性(50Hz 慢扫,GAIN=85/100 压缩区;先跑 1s 建立)');
{
  // 50Hz:高于耦合电容转角(7.2Hz),近似静态;变压器 60Hz HP 衰减 ×0.64
  const N1 = BASE / 50;
  const sweep = (g: number, amp: number) => {
    const ch = makeChain();
    for (let i = 0; i < BASE; i++) ch.process(amp * Math.sin((2 * Math.PI * 50 * i) / BASE), g);
    let maxPos = 0, maxNeg = 0, prevOut = NaN, maxJump = 0;
    for (let i = 0; i < N1; i++) {
      const out = ch.process(amp * Math.sin((2 * Math.PI * 50 * i) / BASE), g);
      maxPos = Math.max(maxPos, out);
      maxNeg = Math.min(maxNeg, out);
      if (Number.isFinite(prevOut)) maxJump = Math.max(maxJump, Math.abs(out - prevOut));
      prevOut = out;
    }
    return { maxPos, maxNeg, maxJump };
  };
  const big = sweep(85, 0.05);
  const small = sweep(85, 0.005);
  // 小信号线性外推 vs 大信号实测峰 → 软压缩判据(避免相位差导致的斜率误判)
  const expected = (small.maxPos / 0.005) * 0.05;
  const compression = big.maxPos / expected;
  const hot = sweep(100, 0.05);
  const hotSmall = sweep(100, 0.005);
  const hotCompression = hot.maxPos / ((hotSmall.maxPos / 0.005) * 0.05);
  const asymHot = Math.abs(hot.maxPos + hot.maxNeg) / (hot.maxPos - hot.maxNeg);
  const asym85 = Math.abs(big.maxPos + big.maxNeg) / (big.maxPos - big.maxNeg);
  check('软压缩(峰被压在 0.5 内,无硬削)', big.maxPos < 0.5 && big.maxPos > 0.05, `正峰=${big.maxPos.toFixed(3)} 负峰=${big.maxNeg.toFixed(3)}`);
  check('传输曲线连续(无跳变)', big.maxJump < 0.05, `maxJump=${big.maxJump.toFixed(4)}`);
  check('峰值增益被压缩(GAIN=100:实测峰 < 0.97×线性外推)', hotCompression < 0.97, `GAIN=100 压缩比=${hotCompression.toFixed(2)}(GAIN=85 时 ${compression.toFixed(2)};RMS 压缩见 L3)`);
  check('不对称压缩(单端近似,H2 来源;GAIN=100)', asymHot > 0.02 && asymHot < 0.7, `asym=${asymHot.toFixed(3)}(GAIN=85 时 ${asym85.toFixed(3)})`);
}

// ---------- L2 线性区频响 ----------
console.log('L2 线性区频响(5mV 小信号,GAIN=50,链深线性区)');
{
  const ch = makeChain();
  const freqs = [40, 60, 120, 250, 500, 1000, 2000, 4000, 5500, 8000, 10000, 16000];
  const gains = freqs.map((f) => {
    const y = renderOs(ch, 50, 0.005, 'out', f);
    return { f, g: goertzelOs(y, f) / 0.005 };
  });
  const g1k = gains.find((x) => x.f === 1000)!.g;
  const db = (g: number) => 20 * Math.log10(g / g1k);
  const at = (f: number) => gains.find((x) => x.f === f)!;
  console.log('   ' + gains.map((x) => `${x.f}Hz:${db(x.g) >= 0 ? '+' : ''}${db(x.g).toFixed(1)}dB`).join(' '));
  const midRefs = [250, 500, 2000].map((f) => Math.abs(db(at(f).g)));
  check('中频平坦(250Hz~2kHz,±3dB)', midRefs.every((d) => d < 3), midRefs.map((d) => `${d.toFixed(1)}`).join('/'));
  check('60Hz HP(40Hz 衰减 ≥1.5dB,60Hz ≥0.5dB)', db(at(40).g) < -1.5 && db(at(60).g) < -0.5, `40Hz=${db(at(40).g).toFixed(1)}dB 60Hz=${db(at(60).g).toFixed(1)}dB`);
  check('5.5kHz LP(10k 衰减 ≥2.5dB,16k ≥7dB)', db(at(10000).g) < -2.5 && db(at(16000).g) < -7, `10k=${db(at(10000).g).toFixed(1)}dB 16k=${db(at(16000).g).toFixed(1)}dB`);
}

// L2b:原生音色栈设计核验(RBJ 双二阶复刻 twinAmpDef.ts 的确切参数)
console.log('L2b 音色栈设计(数值核验 twinAmpDef 的 Biquad 参数)');
{
  type Bi = { b0: number; b1: number; b2: number; a1: number; a2: number };
  const peaking = (f0: number, Q: number, db: number): Bi => {
    const A = Math.pow(10, db / 40);
    const w0 = (2 * Math.PI * f0) / BASE;
    const al = Math.sin(w0) / (2 * Q);
    const a0 = 1 + al / A;
    return {
      b0: (1 + al * A) / a0, b1: (-2 * Math.cos(w0)) / a0, b2: (1 - al * A) / a0,
      a1: (-2 * Math.cos(w0)) / a0, a2: (1 - al / A) / a0,
    };
  };
  const shelf = (f0: number, db: number, high: boolean): Bi => {
    const A = Math.pow(10, db / 40);
    const w0 = (2 * Math.PI * f0) / BASE;
    const c = Math.cos(w0), s = Math.sin(w0);
    const al = s / 2 * Math.sqrt((A + 1 / A) * (1 / 0.9 - 1) + 2); // S=0.9
    const sq = 2 * Math.sqrt(A) * al;
    let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
    if (high) {
      b0 = A * ((A + 1) + (A - 1) * c + sq);
      b1 = -2 * A * ((A - 1) + (A + 1) * c);
      b2 = A * ((A + 1) + (A - 1) * c - sq);
      a0 = (A + 1) - (A - 1) * c + sq;
      a1 = 2 * ((A - 1) - (A + 1) * c);
      a2 = (A + 1) - (A - 1) * c - sq;
    } else {
      b0 = A * ((A + 1) - (A - 1) * c + sq);
      b1 = 2 * A * ((A - 1) - (A + 1) * c);
      b2 = A * ((A + 1) - (A - 1) * c - sq);
      a0 = (A + 1) + (A - 1) * c + sq;
      a1 = -2 * ((A - 1) + (A + 1) * c);
      a2 = (A + 1) + (A - 1) * c - sq;
    }
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  };
  const hAt = (bi: Bi, f: number): number => {
    const w = (2 * Math.PI * f) / BASE;
    const cw = Math.cos(w), sw = Math.sin(w);
    const cw2 = Math.cos(2 * w), sw2 = Math.sin(2 * w);
    const numR = bi.b0 + bi.b1 * cw + bi.b2 * cw2;
    const numI = -bi.b1 * sw - bi.b2 * sw2;
    const denR = 1 + bi.a1 * cw + bi.a2 * cw2;
    const denI = -bi.a1 * sw - bi.a2 * sw2;
    return Math.hypot(numR, numI) / Math.hypot(denR, denI);
  };
  // twinAmpDef 默认值:voicing -3dB@500Q1;bass 55→+1.2;mid 40→-2.4@500Q1;
  // treble 60→+2.4@3k;presence 50→+4@5k;bright 20→+1.2@4k
  const chainDb = (f: number, midV = 40, brightV = 20) => {
    const seq: Bi[] = [
      peaking(500, 1.0, -3),
      shelf(120, ((55 - 50) / 50) * 12, false),
      peaking(500, 1.0, ((midV - 50) / 50) * 12),
      shelf(3000, ((60 - 50) / 50) * 12, true),
      shelf(5000, (50 / 100) * 8, true),
      shelf(4000, (brightV / 100) * 6, true),
    ];
    return 20 * Math.log10(seq.reduce((acc, bi) => acc * hAt(bi, f), 1));
  };
  const scoop = chainDb(500);
  const hf = chainDb(8000);
  const midMax = chainDb(500, 100);
  const midMin = chainDb(500, 0);
  const brightMax = chainDb(8000, 40, 100);
  check('500Hz 中频凹陷 ≈ -5.4dB±1(voicing -3 + mid 默认 -2.4)', scoop > -6.5 && scoop < -4.4, `${scoop.toFixed(1)}dB`);
  check('8kHz 高频晶亮(+6~+9dB:treble+presence+bright 默认)', hf > 6 && hf < 9, `${hf.toFixed(1)}dB`);
  check('MID 行程(500Hz:-15dB~+9dB)', midMin < -13 && midMax > 7, `${midMin.toFixed(1)}~${midMax.toFixed(1)}dB`);
  check('BRIGHT 行程(8kHz 额外 ≥+4dB)', brightMax - hf > 4, `+${(brightMax - hf).toFixed(1)}dB`);
}

// ---------- L3 非线性行为 ----------
console.log('L3 非线性行为');
{
  // 1) THD 随 GAIN 单调上升(50→100)
  const gs = [50, 60, 70, 85, 100];
  const thds = gs.map((g) => ({ g, ...thdOs(renderOs(makeChain(), g, 0.05, 'out'), 1000) }));
  const mono = thds.every((t, i) => i === 0 || t.thd >= thds[i - 1].thd - 1e-6);
  check('THD 随 GAIN 上升(50→100)', mono, thds.map((t) => `g${t.g}:${(t.thd * 100).toFixed(2)}%`).join(' '));
  const h2dom = thdOs(renderOs(makeChain(), 100, 0.05, 'out'), 1000);
  check('压缩区 H2>H3(后级截止/栅流不对称)', h2dom.h2 > h2dom.h3, `H2=${(h2dom.h2 * 100).toFixed(1)}% H3=${(h2dom.h3 * 100).toFixed(1)}%`);

  // 2) 大输入不削波区
  const zone: [number, number, number][] = [[50, 0.05, 0.01], [50, 0.1, 0.01], [50, 0.15, 0.03], [40, 0.2, 0.015]];
  const zoneRes = zone.map(([g, amp, lim]) => {
    const t = thdOs(renderOs(makeChain(), g, amp, 'out'), 1000).thd;
    return { g, amp, lim, t };
  });
  check(
    '大输入不削波区(GAIN≤50,≤150mV 净;GAIN=40,200mV 净)',
    zoneRes.every((z) => z.t < z.lim),
    zoneRes.map((z) => `g${z.g}/${(z.amp * 1000).toFixed(0)}mV:${(z.t * 100).toFixed(2)}%(限${(z.lim * 100).toFixed(0)}%)`).join(' '),
  );

  // 3) 边缘压缩区:压缩比 + THD 区间
  const compAt = (g: number) => {
    const r1 = rms(renderOs(makeChain(), g, 0.05, 'out'));
    const r2 = rms(renderOs(makeChain(), g, 0.1, 'out'));
    const t = thdOs(renderOs(makeChain(), g, 0.05, 'out'), 1000).thd;
    return { ratio: r2 / r1, thd: t };
  };
  const c75 = compAt(75);
  const c100 = compAt(100);
  check('边缘压缩区 GAIN=75(压缩比<1.9,THD 0.3~4%)', c75.ratio < 1.9 && c75.thd > 0.003 && c75.thd < 0.04, `×${c75.ratio.toFixed(2)} THD=${(c75.thd * 100).toFixed(2)}%`);
  check('边缘压缩区 GAIN=100(压缩比<1.6,THD 4~20%)', c100.ratio < 1.6 && c100.thd > 0.04 && c100.thd < 0.2, `×${c100.ratio.toFixed(2)} THD=${(c100.thd * 100).toFixed(2)}%`);

  // 4) 后级主导 + CF 透明(前级几乎不削波)
  {
    const ch = makeChain();
    const yPw = renderOs(ch, 100, 0.05, 'pw');
    const yCf = renderOs(ch, 100, 0.05, 'cf');
    const tPw = thdOs(yPw, 1000).thd;
    const tCf = thdOs(yCf, 1000).thd;
    check('后级主导(GAIN=100:THD(pw) > THD(cf))', tPw > tCf, `pw=${(tPw * 100).toFixed(1)}% cf=${(tCf * 100).toFixed(1)}%`);
    check('前级几乎不削波(GAIN=100 时 CF 出 THD<6%)', tCf < 0.06, `${(tCf * 100).toFixed(1)}%`);
  }

  // 5) 载波边带(motorboating 检查,整数周期 1s 窗,GAIN=100 重驱动)
  {
    const ch = makeChain();
    const y = renderBase(ch, 100, 0.05, BASE, 1000, 1.0);
    const carrier = goertzelBase(y, 1000);
    const sb = Math.hypot(goertzelBase(y, 994), goertzelBase(y, 1006)) / carrier;
    const sb2 = Math.hypot(goertzelBase(y, 988), goertzelBase(y, 1012)) / carrier;
    check('无 motorboating(±6Hz 边带 <-35dB)', 20 * Math.log10(Math.max(sb, 1e-12)) < -35, `±6Hz=${(20 * Math.log10(Math.max(sb, 1e-12))).toFixed(1)}dB ±12Hz=${(20 * Math.log10(Math.max(sb2, 1e-12))).toFixed(1)}dB`);
  }

  // 6) 混叠(完整重采样路径,精确整数周期 DFT,GAIN=60 中驱动)
  {
    const N = 8192;
    const HARM_BIN = 171; // 1001.95Hz,采样窗整数倍
    const FREQ = (BASE * HARM_BIN) / N;
    const ch = makeChain();
    const y = renderBase(ch, 60, 0.05, N, FREQ, 0.5);
    const harmBins = new Set<number>();
    for (let h = 0; h * HARM_BIN < N / 2; h++) {
      for (let d = -1; d <= 1; d++) harmBins.add(h * HARM_BIN + d);
    }
    let eTotal = 0, eHarm = 0;
    for (let k = 1; k < N / 2; k++) {
      let re = 0, im = 0;
      for (let n = 0; n < N; n++) {
        const a = (-2 * Math.PI * k * n) / N;
        re += y[n] * Math.cos(a);
        im += y[n] * Math.sin(a);
      }
      const e = re * re + im * im;
      eTotal += e;
      if (harmBins.has(k)) eHarm += e;
    }
    const imgDb = 10 * Math.log10(Math.max(1e-20, (eTotal - eHarm) / eTotal));
    check('混叠抑制(非谐波能量比 <-45dB)', imgDb < -45, `${imgDb.toFixed(1)}dB`);
  }
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项未过 ✗`);
if (failures > 0) process.exit(1);
