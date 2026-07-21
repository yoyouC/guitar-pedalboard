/**
 * TS808 WDF 正确性评测(L0~L3,Node 直跑:npm run wdf:ts-eval)
 * 对照基准:ElectroSmash TS 电路分析(720Hz 反馈 HP / 723Hz 音色级 LP / 对称软削波)
 */
import { TsClipperStage } from '../src/audio/wdf/diodeClipper.ts';
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from '../src/audio/wdf/resample.ts';

const BASE = 48000;
const FS = BASE * OS_FACTOR;
const T = 1 / FS;

/** 与 worklet 同构的完整 TS808 链(削波级 + 723Hz LP + tone 高架) */
function makeChain(drive: number, tone: number) {
  const clipper = new TsClipperStage({ fs: FS });
  clipper.setDrive(drive);
  const fir = makeAntiAliasFIR();
  const up = new Upsampler4x(fir);
  const down = new Decimator4x(fir);
  const aLp = T / (1 / (2 * Math.PI * 723) + T);
  const aTone = T / (1 / (2 * Math.PI * 3200) + T);
  const toneG = Math.pow(10, (((tone - 50) / 50) * 15) / 20);
  let lpY1 = 0, toneLpY1 = 0;
  const osBuf = new Float32Array(OS_FACTOR);
  const osOut = [0, 0, 0, 0];
  return {
    clipper,
    process(x: number): number {
      up.process(osBuf, x);
      for (let k = 0; k < OS_FACTOR; k++) {
        const s = clipper.process(osBuf[k]);
        lpY1 += aLp * (s - lpY1);
        toneLpY1 += aTone * (lpY1 - toneLpY1);
        osOut[k] = toneLpY1 + toneG * (lpY1 - toneLpY1);
      }
      return down.process(osOut[0], osOut[1], osOut[2], osOut[3]);
    },
  };
}

function settleAndCapture(chain: { process(x: number): number }, freq: number, amp: number, n: number): Float64Array {
  for (let i = 0; i < FS / 10 / OS_FACTOR; i++) chain.process(amp * Math.sin((2 * Math.PI * freq * i) / BASE));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = chain.process(amp * Math.sin((2 * Math.PI * freq * (i + FS / 10 / OS_FACTOR)) / BASE));
  return out;
}

function rms(y: Float64Array): number {
  let s = 0;
  for (const v of y) s += v * v;
  return Math.sqrt(s / y.length);
}

/** 单频点幅度(Goertzel) */
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
  const c = new TsClipperStage({ fs: FS });
  c.setDrive(0.8);
  let nan = 0, maxAbs = 0;
  for (let i = 0; i < FS / 2; i++) {
    const out = c.process(2 * Math.sin((2 * Math.PI * 1000 * i) / FS));
    if (!Number.isFinite(out)) nan++;
    maxAbs = Math.max(maxAbs, Math.abs(out));
  }
  check('无 NaN', nan === 0, `nan=${nan}`);
  check('输出有界', maxAbs < 50, `maxAbs=${maxAbs.toFixed(2)}`);
  const avgIter = c.iterTotal / Math.max(1, c.iterCount);
  check('Newton 收敛(平均 <10 次)', avgIter < 10, `avg=${avgIter.toFixed(1)}`);

  const c2 = new TsClipperStage({ fs: FS });
  let silentMax = 0;
  for (let i = 0; i < FS / 10; i++) silentMax = Math.max(silentMax, Math.abs(c2.process(0)));
  check('静音→静音(无极限环)', silentMax < 1e-9, `silentMax=${silentMax.toExponential(1)}`);
}

// ---------- L1 静态传输特性 ----------
console.log('L1 静态传输特性(慢扫,削波级)');
{
  const c = new TsClipperStage({ fs: FS });
  c.setDrive(0.5);
  // 1Hz 慢扫 ≈ 静态;跑两个完整周期,测最后一个整周期
  let maxPos = 0, maxNeg = 0;
  let prevOut = 0, maxSlopeJump = 0;
  for (let i = 0; i < BASE * 2; i++) {
    const ph = (2 * Math.PI * i) / BASE; // 1Hz
    const out = c.process(1 * Math.sin(ph));
    if (i >= BASE) {
      // 第二周期(整周期)
      maxPos = Math.max(maxPos, out);
      maxNeg = Math.min(maxNeg, out);
      maxSlopeJump = Math.max(maxSlopeJump, Math.abs(out - prevOut));
    }
    prevOut = out;
  }
  const asym = Math.abs(maxPos + maxNeg) / (maxPos - maxNeg);
  check('软削波(峰被压在 Vf 附近)', maxPos < 2 && maxPos > 0.5, `正峰=${maxPos.toFixed(2)}V`);
  check('对称削波(不对称度 < 0.02)', asym < 0.02, `asym=${asym.toFixed(4)} (pos=${maxPos.toFixed(2)} neg=${maxNeg.toFixed(2)})`);
  check('传输曲线连续(无跳变)', maxSlopeJump < 1, `maxJump=${maxSlopeJump.toFixed(3)}`);
}

// ---------- L2 线性区频响 ----------
console.log('L2 线性区频响(10mV 小信号,对照 720Hz HP / 723Hz LP)');
{
  const chain = makeChain(0.5, 100); // tone 全开,隔离 LP 影响最小化? tone=100 → 高架 +3dB 高频
  const freqs = [50, 100, 200, 400, 700, 1000, 2000, 4000, 8000, 16000];
  const gains = freqs.map((f) => {
    const y = settleAndCapture(chain, f, 0.01, 4096);
    return { f, g: goertzel(y, f) / 0.01 };
  });
  const peak = gains.reduce((a, b) => (b.g > a.g ? b : a));
  check('中频隆起峰值 ≈ 700Hz(600~1000)', peak.f >= 600 && peak.f <= 1000, `peak=${peak.f}Hz`);
  const g100 = gains.find((x) => x.f === 100)!;
  check('100Hz 衰减(720HP)', peak.g / g100.g > 3, `${(20 * Math.log10(peak.g / g100.g)).toFixed(1)}dB`);
  const g16k = gains.find((x) => x.f === 16000)!;
  check('16kHz 衰减(723LP)', peak.g / g16k.g > 3, `${(20 * Math.log10(peak.g / g16k.g)).toFixed(1)}dB`);
}

// ---------- L3 非线性行为 ----------
console.log('L3 非线性行为');
{
  // THD 随 DRIVE 单调上升(50mV 输入,避免一进就饱和)
  const thds = [0.1, 0.3, 0.6, 1.0].map((d) => {
    const chain = makeChain(d, 55);
    const y = settleAndCapture(chain, 1000, 0.05, 8192);
    return { d, ...thd(y, 1000) };
  });
  const mono = thds.every((t, i) => i === 0 || t.thd >= thds[i - 1].thd - 1e-6);
  check('THD 随 drive 上升', mono, thds.map((t) => `d${t.d}:${(t.thd * 100).toFixed(1)}%`).join(' '));
  const h2h3Max = Math.max(...thds.map((t) => t.h2h3));
  check('奇谐波主导(H2/H3 < 1)', h2h3Max < 1, `max H2/H3=${h2h3Max.toFixed(2)}`);

  // 频率选择性失真:在削波级出口直接测(剔除音色级 LP 对高次谐波的衰减干扰)
  const thdAt = (freq: number) => {
    const c = new TsClipperStage({ fs: FS });
    c.setDrive(0.7);
    const N = 8192 * OS_FACTOR;
    const y = new Float64Array(N);
    for (let i = 0; i < N; i++) y[i] = c.process(0.05 * Math.sin((2 * Math.PI * freq * i) / FS));
    // Goertzel @ OS 速率
    const g = (f: number) => {
      const w = (2 * Math.PI * f) / FS;
      let re = 0, im = 0;
      for (let n = 0; n < N; n++) {
        re += y[n] * Math.cos(w * n);
        im -= y[n] * Math.sin(w * n);
      }
      return (2 * Math.hypot(re, im)) / N;
    };
    const f1 = g(freq);
    const h = Math.sqrt(g(freq * 2) ** 2 + g(freq * 3) ** 2 + g(freq * 4) ** 2 + g(freq * 5) ** 2);
    return h / f1;
  };
  const t100 = thdAt(100);
  const t1k = thdAt(1000);
  check('频率选择性失真(削波级:100Hz THD < 1kHz THD)', t100 < t1k, `100Hz=${(t100 * 100).toFixed(1)}% vs 1kHz=${(t1k * 100).toFixed(1)}%`);
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项未过 ✗`);
if (failures > 0) process.exit(1);
