/**
 * Klon Centaur WDF 正确性评测(L0~L3,Node 直跑:node scripts/wdf-klon-eval.ts)
 * 对照基准:Klon 电路特征(锗管软削波 Vf≈0.3V / GAIN 联动干湿混合 / 3kHz 高架 ±10dB)
 */
import {
  KlonClipperStage,
  klonDryCoeff,
  klonGainForKnob,
} from '../src/audio/wdf/klonCentaur.ts';
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from '../src/audio/wdf/resample.ts';

const BASE = 48000;
const FS = BASE * OS_FACTOR;
const T = 1 / FS;

/** 与 worklet 同构的完整 Klon 链(增益级 + 削波 + 干湿混合 + 3kHz 高架) */
function makeChain(knob: number, treble: number, dryOverride?: number) {
  const clipper = new KlonClipperStage();
  const fir = makeAntiAliasFIR();
  const up = new Upsampler4x(fir);
  const down = new Decimator4x(fir);
  const g = klonGainForKnob(knob);
  const dryW = dryOverride ?? klonDryCoeff(knob);
  // dB 镜像对称高架:衰减时转角下移至 fc·G(cut 响应 = boost 响应的 dB 镜像)
  const toneG = Math.pow(10, (((treble - 50) / 50) * 10) / 20);
  const fcShelf = toneG >= 1 ? 3000 : 3000 * toneG;
  const aTone = T / (1 / (2 * Math.PI * fcShelf) + T);
  let toneLpY1 = 0;
  const osBuf = new Float32Array(OS_FACTOR);
  const osOut = [0, 0, 0, 0];
  return {
    clipper,
    process(x: number): number {
      up.process(osBuf, x);
      for (let k = 0; k < OS_FACTOR; k++) {
        const vd = clipper.process(g * osBuf[k]);
        const sum = vd + dryW * osBuf[k];
        toneLpY1 += aTone * (sum - toneLpY1);
        osOut[k] = toneLpY1 + toneG * (sum - toneLpY1);
      }
      return down.process(osOut[0], osOut[1], osOut[2], osOut[3]);
    },
  };
}

/** ≥0.5s 建立期后采集 n 个样本(见 wdf-whitebox-process.md §4.2) */
function settleAndCapture(chain: { process(x: number): number }, freq: number, amp: number, n: number): Float64Array {
  const settle = BASE / 2;
  for (let i = 0; i < settle; i++) chain.process(amp * Math.sin((2 * Math.PI * freq * i) / BASE));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = chain.process(amp * Math.sin((2 * Math.PI * freq * (i + settle)) / BASE));
  return out;
}

/** 单频点幅度(Goertzel;采样窗取整数周期,见 §4.3) */
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

/** 整数周期采样窗:≥minN 个样本且为 freq 周期整数倍 */
function intPeriodN(freq: number, minN: number): number {
  const period = BASE / freq;
  return Math.ceil(minN / period) * period;
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
  const c = new KlonClipperStage();
  let nan = 0, maxAbs = 0;
  // 直接馈大信号运放输出(knob=1 时 2V 输入 → vo 峰值 400V 量级)
  for (let i = 0; i < FS / 2; i++) {
    const out = c.process(400 * Math.sin((2 * Math.PI * 1000 * i) / FS));
    if (!Number.isFinite(out)) nan++;
    maxAbs = Math.max(maxAbs, Math.abs(out));
  }
  check('无 NaN', nan === 0, `nan=${nan}`);
  check('输出有界', maxAbs < 2, `maxAbs=${maxAbs.toFixed(3)}`);
  const avgIter = c.iterTotal / Math.max(1, c.iterCount);
  check('Newton 收敛(平均 <10 次)', avgIter < 10, `avg=${avgIter.toFixed(1)}`);

  const c2 = new KlonClipperStage();
  let silentMax = 0;
  for (let i = 0; i < FS / 10; i++) silentMax = Math.max(silentMax, Math.abs(c2.process(0)));
  check('静音→静音(无极限环)', silentMax < 1e-9, `silentMax=${silentMax.toExponential(1)}`);
}

// ---------- L1 静态传输特性 ----------
console.log('L1 静态传输特性(慢扫,削波级)');
{
  const c = new KlonClipperStage();
  // 1Hz 慢扫 ≈ 静态;跑两个完整周期,测最后一个整周期
  let maxPos = 0, maxNeg = 0;
  let prevOut = 0, maxSlopeJump = 0;
  for (let i = 0; i < BASE * 2; i++) {
    const ph = (2 * Math.PI * i) / BASE; // 1Hz
    const out = c.process(50 * Math.sin(ph));
    if (i >= BASE) {
      maxPos = Math.max(maxPos, out);
      maxNeg = Math.min(maxNeg, out);
      maxSlopeJump = Math.max(maxSlopeJump, Math.abs(out - prevOut));
    }
    prevOut = out;
  }
  const asym = Math.abs(maxPos + maxNeg) / (maxPos - maxNeg);
  check('软削波(峰被压在锗管 Vf≈0.3V 附近)', maxPos > 0.25 && maxPos < 0.45, `正峰=${maxPos.toFixed(3)}V`);
  check('对称削波(不对称度 < 0.02)', asym < 0.02, `asym=${asym.toFixed(4)} (pos=${maxPos.toFixed(3)} neg=${maxNeg.toFixed(3)})`);
  check('传输曲线连续(无跳变)', maxSlopeJump < 0.01, `maxJump=${maxSlopeJump.toFixed(5)}`);
}

// ---------- L2 线性区频响 ----------
console.log('L2 线性区频响(10mV 小信号,knob=0 线性区)');
{
  const freqs = [100, 200, 400, 1000, 2000, 4000, 8000];
  const sweep = (treble: number) => {
    const chain = makeChain(0, treble);
    return freqs.map((f) => {
      const y = settleAndCapture(chain, f, 0.01, intPeriodN(f, 4096));
      return { f, g: goertzel(y, f) / 0.01 };
    });
  };
  const db = (x: number) => 20 * Math.log10(x);

  const flat = sweep(50); // treble 中性 → 高架 0dB,应全频平坦
  const g1k = flat.find((x) => x.f === 1000)!.g;
  const maxDev = Math.max(...flat.map((x) => Math.abs(db(x.g / g1k))));
  check('treble=50 频响平坦(100Hz~8kHz,偏差 <0.5dB)', maxDev < 0.5, `maxDev=${maxDev.toFixed(2)}dB`);

  const boost = sweep(100);
  const shelfUp = db(boost.find((x) => x.f === 8000)!.g / boost.find((x) => x.f === 100)!.g);
  check('treble=100 高架 ≈ +10dB @8kHz(8~12dB)', shelfUp > 8 && shelfUp < 12, `${shelfUp.toFixed(1)}dB`);

  const cut = sweep(0);
  const shelfDn = db(cut.find((x) => x.f === 8000)!.g / cut.find((x) => x.f === 100)!.g);
  check('treble=0 高架 ≈ -10dB @8kHz(-12~-8dB)', shelfDn > -12 && shelfDn < -8, `${shelfDn.toFixed(1)}dB`);
}

// ---------- L3 非线性行为 ----------
console.log('L3 非线性行为');
{
  // THD 随 GAIN 单调上升(50mV 输入)
  const thds = [0.1, 0.3, 0.5, 0.8].map((knob) => {
    const chain = makeChain(knob, 50);
    const y = settleAndCapture(chain, 1000, 0.05, intPeriodN(1000, 8192));
    return { knob, ...thd(y, 1000) };
  });
  const mono = thds.every((t, i) => i === 0 || t.thd >= thds[i - 1].thd - 1e-6);
  check('THD 随 GAIN 上升', mono, thds.map((t) => `k${t.knob}:${(t.thd * 100).toFixed(1)}%`).join(' '));
  const h2h3Max = Math.max(...thds.slice(1).map((t) => t.h2h3));
  check('奇谐波主导(H2/H3 < 1)', h2h3Max < 1, `max H2/H3=${h2h3Max.toFixed(2)}`);

  // Klon 关键特征:GAIN 联动的干声混合降低输出 THD("透明"感的来源)
  const blended = makeChain(0.5, 50);
  const yBlend = settleAndCapture(blended, 1000, 0.05, intPeriodN(1000, 8192));
  const pure = makeChain(0.5, 50, 0); // 同增益、干声强制为 0
  const yPure = settleAndCapture(pure, 1000, 0.05, intPeriodN(1000, 8192));
  const tBlend = thd(yBlend, 1000).thd;
  const tPure = thd(yPure, 1000).thd;
  check('干声混合降低 THD(knob=0.5:混合 < 纯湿声)', tBlend < tPure, `混合=${(tBlend * 100).toFixed(1)}% vs 纯湿=${(tPure * 100).toFixed(1)}%`);

  // 低增益近透明:knob=0.1 时 THD 明显低于高增益
  check('低增益近透明(knob=0.1 THD < 5%)', thds[0].thd < 0.05, `THD=${(thds[0].thd * 100).toFixed(2)}%`);
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项未过 ✗`);
if (failures > 0) process.exit(1);
