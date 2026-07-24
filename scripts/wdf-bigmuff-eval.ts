/**
 * Big Muff Pi WDF 正确性评测(L0~L3,Node 直跑:node scripts/wdf-bigmuff-eval.ts)
 * 对照基准:
 *  - ElectroSmash Big Muff Pi Analysis(V3):两级 2N5088 增益 + 1N4148 对地对称软削波
 *    + TONE 交叉淡化(LP 39k/10n ≈ 325Hz,HP 4n/22k ≈ 1.8kHz,中位中频凹陷)
 *  - ngspice 全 BJT 小信号校准:级间 Miller 加载极点 ~920Hz、级间耦合 HP ~155Hz
 */
import { BigMuffChain, MuffClipStage, MuffTone, MUFF } from '../src/audio/wdf/bigmuff.ts';
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from '../src/audio/wdf/resample.ts';

const BASE = 48000;
const FS = BASE * OS_FACTOR;

/** 与 worklet 同构的完整基率链(4x 过采样) */
function makeChain(sustain: number, tone: number) {
  const chain = new BigMuffChain(FS);
  chain.setSustain(sustain);
  chain.setTone(tone);
  const fir = makeAntiAliasFIR();
  const up = new Upsampler4x(fir);
  const down = new Decimator4x(fir);
  const osBuf = new Float32Array(OS_FACTOR);
  const osOut = [0, 0, 0, 0];
  return {
    chain,
    process(x: number): number {
      up.process(osBuf, x);
      for (let k = 0; k < OS_FACTOR; k++) osOut[k] = chain.process(osBuf[k]);
      return down.process(osOut[0], osOut[1], osOut[2], osOut[3]);
    },
  };
}

/** ≥0.5s 建立期(最慢极点 3.2Hz,τ≈50ms,10τ)后采集 n 点 */
function settleAndCapture(chain: { process(x: number): number }, freq: number, amp: number, n: number): Float64Array {
  const SETTLE = BASE / 2;
  for (let i = 0; i < SETTLE; i++) chain.process(amp * Math.sin((2 * Math.PI * freq * i) / BASE));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = chain.process(amp * Math.sin((2 * Math.PI * freq * (i + SETTLE)) / BASE));
  return out;
}

/** 单频点幅度(Goertzel,基率;窗长取 4800=10Hz 整数周期格) */
function goertzel(y: Float64Array, freq: number): number {
  const N = y.length;
  const w = (2 * Math.PI * freq) / BASE;
  let re = 0, im = 0;
  for (let n = 0; n < N; n++) {
    re += y[n] * Math.cos(w * n);
    im -= y[n] * Math.sin(w * n);
  }
  return (2 * Math.hypot(re, im)) / N;
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
console.log('L0 求解器健康');
{
  const c = new BigMuffChain(FS);
  c.setSustain(1.0);
  c.setTone(0.5);
  let nan = 0, maxAbs = 0;
  for (let i = 0; i < FS / 2; i++) {
    const out = c.process(2 * Math.sin((2 * Math.PI * 1000 * i) / FS));
    if (!Number.isFinite(out)) nan++;
    maxAbs = Math.max(maxAbs, Math.abs(out));
  }
  check('无 NaN', nan === 0, `nan=${nan}`);
  check('输出有界(两级钳位 < 2V)', maxAbs < 2, `maxAbs=${maxAbs.toFixed(3)}`);
  const it1 = c.stage1.iterTotal / Math.max(1, c.stage1.iterCount);
  const it2 = c.stage2.iterTotal / Math.max(1, c.stage2.iterCount);
  check('Newton 收敛(平均 <10 次)', it1 < 10 && it2 < 10, `stage1=${it1.toFixed(1)} stage2=${it2.toFixed(1)}`);

  const c2 = new BigMuffChain(FS);
  let silentMax = 0;
  for (let i = 0; i < FS / 10; i++) silentMax = Math.max(silentMax, Math.abs(c2.process(0)));
  check('静音→静音(无极限环)', silentMax < 1e-9, `silentMax=${silentMax.toExponential(1)}`);
}

// ---------- L1 静态传输特性 ----------
console.log('L1 静态传输特性(慢扫)');
{
  for (const [name, A, Rth] of [['级1', MUFF.A1, MUFF.RTH1], ['级2', MUFF.A2, MUFF.RTH2]] as const) {
    const st = new MuffClipStage(A, Rth);
    let maxPos = 0, maxNeg = 0, prevOut = 0, maxJump = 0;
    for (let i = 0; i < FS * 2; i++) {
      const out = st.process(1 * Math.sin((2 * Math.PI * i) / FS)); // 1Hz
      if (i >= FS) {
        maxPos = Math.max(maxPos, out);
        maxNeg = Math.min(maxNeg, out);
        maxJump = Math.max(maxJump, Math.abs(out - prevOut));
      }
      prevOut = out;
    }
    const asym = Math.abs(maxPos + maxNeg) / (maxPos - maxNeg);
    check(`${name} 软削波峰在 Vf 附近(0.4~0.8V)`, maxPos < 0.8 && maxPos > 0.4, `正峰=${maxPos.toFixed(3)}V`);
    check(`${name} 对称削波(asym<0.02)`, asym < 0.02, `asym=${asym.toFixed(4)}`);
    check(`${name} 传输连续(无跳变)`, maxJump < 0.1, `maxJump=${maxJump.toFixed(4)}`);
  }
  // 全链:交流耦合链路无真静态,用 1kHz 高驱动测峰对称性
  const c = new BigMuffChain(FS);
  c.setSustain(1);
  c.setTone(0.5);
  let maxPos = 0, maxNeg = 0;
  for (let i = 0; i < FS / 2; i++) {
    const out = c.process(0.2 * Math.sin((2 * Math.PI * 1000 * i) / FS));
    if (i >= FS / 4) {
      maxPos = Math.max(maxPos, out);
      maxNeg = Math.min(maxNeg, out);
    }
  }
  const asym = Math.abs(maxPos + maxNeg) / (maxPos - maxNeg);
  check('全链对称(asym<0.05)', asym < 0.05, `asym=${asym.toFixed(4)} (pos=${maxPos.toFixed(3)} neg=${maxNeg.toFixed(3)})`);
}

// ---------- L2 线性区频响 ----------
console.log('L2 线性区频响(小信号)');
{
  // 2a) TONE 网络单独测(OS 速率直驱,对照理论极点 325Hz LP / 1.81kHz HP)
  const toneGain = (t: number, f: number): number => {
    const mt = new MuffTone(FS);
    mt.setTone(t);
    const SETTLE = FS / 4, N = 19200; // 0.1s 窗,10Hz 整数格
    let re = 0, im = 0;
    for (let i = 0; i < SETTLE + N; i++) {
      const y = mt.process(1 * Math.sin((2 * Math.PI * f * i) / FS));
      if (i >= SETTLE) {
        re += y * Math.cos((2 * Math.PI * f * (i - SETTLE)) / FS);
        im -= y * Math.sin((2 * Math.PI * f * (i - SETTLE)) / FS);
      }
    }
    return (2 * Math.hypot(re, im)) / N;
  };
  const corner = (t: number, refF: number, lo: number, hi: number, rising: boolean): number => {
    const ref = toneGain(t, refF) / Math.SQRT2;
    for (let f = lo; f <= hi; f += 10) {
      const g = toneGain(t, f);
      if ((!rising && g < ref) || (rising && g > ref)) return f;
    }
    return -1;
  };
  const lpCorner = corner(0, 50, 100, 800, false);
  check('TONE=0 LP 拐点(理论 325Hz,电位器/HP 臂负载使其上移,300~500)', lpCorner >= 300 && lpCorner <= 500, `fc=${lpCorner}Hz`);
  const hpCorner = corner(1, 8000, 1000, 4000, true);
  check('TONE=1 HP 拐点 ≈1.8kHz(1.4~2.2k)', hpCorner >= 1400 && hpCorner <= 2200, `fc=${hpCorner}Hz`);
  // 中位凹陷:同频点 min(两端)/中位 的最大比值
  let maxScoop = 0, scoopF = 0;
  for (const f of [300, 500, 800, 1000, 1500, 2000, 3000]) {
    const s = Math.min(toneGain(0, f), toneGain(1, f)) / toneGain(0.5, f);
    if (s > maxScoop) { maxScoop = s; scoopF = f; }
  }
  check('TONE=50 中频凹陷 ≥4dB', 20 * Math.log10(maxScoop) >= 4, `scoop=${(20 * Math.log10(maxScoop)).toFixed(1)}dB @${scoopF}Hz`);

  // 2b) 全链频响(0.2mV,sustain=1,过采样基率链)
  const chainGain = (tone: number, f: number): number => {
    const y = settleAndCapture(makeChain(1, tone), f, 2e-4, 4800);
    return goertzel(y, f) / 2e-4;
  };
  const g40 = chainGain(0.5, 40);
  const g300 = chainGain(0.5, 300);
  check('全链低频衰减(90+155Hz HP:40Hz 比 300Hz 低 ≥10dB)',
    20 * Math.log10(g300 / g40) >= 10, `${(20 * Math.log10(g300 / g40)).toFixed(1)}dB`);
  const g1500 = chainGain(1, 1500);
  const g8000 = chainGain(1, 8000);
  check('全链高频衰减(920Hz Miller 极点:tone=1 时 8k 比 1.5k 低 ≥6dB)',
    20 * Math.log10(g1500 / g8000) >= 6, `${(20 * Math.log10(g1500 / g8000)).toFixed(1)}dB`);
}

// ---------- L3 非线性行为 ----------
console.log('L3 非线性行为(10mV 1kHz,tone=50;50mV 一进就饱和,区分度差)');
{
  const thds = [0.1, 0.3, 0.6, 1.0].map((s) => {
    const y = settleAndCapture(makeChain(s, 0.5), 1000, 0.01, 4800);
    return { s, ...thd(y, 1000) };
  });
  const mono = thds.every((t, i) => i === 0 || t.thd >= thds[i - 1].thd - 1e-6);
  check('THD 随 SUSTAIN 单调上升', mono, thds.map((t) => `s${t.s}:${(t.thd * 100).toFixed(1)}%`).join(' '));
  const h2h3Max = Math.max(...thds.map((t) => t.h2h3));
  check('奇谐波主导(H2/H3 < 1,对称削波)', h2h3Max < 1, `max H2/H3=${h2h3Max.toFixed(2)}`);
  check('高 SUSTAIN 近方波(THD@1.0 ≥ 25%)', thds[3].thd >= 0.25, `THD=${(thds[3].thd * 100).toFixed(1)}%`);

  // 削波电平:sustain=1 时两级输出峰 ≈ ±0.6V(直接 OS 速率链测)
  const c = new BigMuffChain(FS);
  c.setSustain(1);
  c.setTone(0.5);
  let pk1 = 0, pk2 = 0;
  for (let i = 0; i < FS / 2; i++) {
    const { c1, c2 } = c.processWithTaps(0.05 * Math.sin((2 * Math.PI * 1000 * i) / FS));
    if (i > FS / 10) {
      pk1 = Math.max(pk1, Math.abs(c1));
      pk2 = Math.max(pk2, Math.abs(c2));
    }
  }
  check('级1/级2 削波峰 0.4~0.8V', pk1 > 0.4 && pk1 < 0.8 && pk2 > 0.4 && pk2 < 0.8,
    `pk1=${pk1.toFixed(3)}V pk2=${pk2.toFixed(3)}V`);
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项未过 ✗`);
if (failures > 0) process.exit(1);
