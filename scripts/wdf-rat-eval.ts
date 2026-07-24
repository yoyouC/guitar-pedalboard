/**
 * RAT WDF 正确性评测(L0~L3,Node 直跑:node scripts/wdf-rat-eval.ts)
 * 对照基准:ElectroSmash Pro Co Rat 电路分析
 *   (1.5kHz 反馈高通 / LM308 摆率 5.3kHz 低通 / 1N914 对地硬削波 /
 *    FILTER 反向 475Hz~32kHz / 奇谐波主导 / 频率选择性失真)
 * 测量规范:≥0.5s 建立期;Goertzel 测频一律取采样窗整数周期(频率均整除 48kHz)。
 */
import { RatStage, filterToFreq } from '../src/audio/wdf/ratDistortion.ts';
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from '../src/audio/wdf/resample.ts';

const BASE = 48000;
const FS = BASE * OS_FACTOR;
const SETTLE = BASE / 2; // 0.5s 建立期(§4.2)

/** 与 worklet 同构的完整 RAT 链(失真级 + 4x 重采样,level=1) */
function makeChain(drive: number, filter: number) {
  const rat = new RatStage({ fs: FS });
  rat.setDrive(drive);
  rat.setFilter(filter);
  const fir = makeAntiAliasFIR();
  const up = new Upsampler4x(fir);
  const down = new Decimator4x(fir);
  const osBuf = new Float32Array(OS_FACTOR);
  return {
    rat,
    process(x: number): number {
      up.process(osBuf, x);
      const y0 = rat.process(osBuf[0]);
      const y1 = rat.process(osBuf[1]);
      const y2 = rat.process(osBuf[2]);
      const y3 = rat.process(osBuf[3]);
      return down.process(y0, y1, y2, y3);
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
  for (let i = 0; i < n; i++) out[i] = chain.process(amp * Math.sin((2 * Math.PI * freq * (i + SETTLE)) / BASE));
  return out;
}

/** freq 整除 BASE 时的整周期窗长(≥minN) */
function cycleLen(freq: number, minN: number): number {
  const per = BASE / freq;
  if (!Number.isInteger(per)) throw new Error(`freq ${freq} 不整除 ${BASE}`);
  return per * Math.max(1, Math.ceil(minN / per));
}

/** 单频点幅度(Goertzel,整周期窗 = DFT 单 bin) */
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
  const c = new RatStage({ fs: FS });
  c.setDrive(0.8);
  c.setFilter(35);
  let nan = 0, maxAbs = 0;
  for (let i = 0; i < FS / 2; i++) {
    const out = c.process(0.2 * Math.sin((2 * Math.PI * 1000 * i) / FS));
    if (!Number.isFinite(out)) nan++;
    maxAbs = Math.max(maxAbs, Math.abs(out));
  }
  check('无 NaN', nan === 0, `nan=${nan}`);
  check('输出有界(硬削波 < 2V)', maxAbs < 2, `maxAbs=${maxAbs.toFixed(2)}`);
  const avgIter = c.iterTotal / Math.max(1, c.iterCount);
  check('Newton 收敛(平均 <10 次)', avgIter < 10, `avg=${avgIter.toFixed(1)}`);

  const c2 = new RatStage({ fs: FS });
  let silentMax = 0;
  for (let i = 0; i < FS / 10; i++) silentMax = Math.max(silentMax, Math.abs(c2.process(0)));
  check('静音→静音(无极限环)', silentMax < 1e-9, `silentMax=${silentMax.toExponential(1)}`);
}

// ---------- L1 静态传输特性 ----------
console.log('L1 静态传输特性(4Hz 慢扫,失真级,drive=0.5 filter=0)');
{
  const c = new RatStage({ fs: FS });
  c.setDrive(0.5);
  c.setFilter(0);
  // 4Hz 慢扫 ≈ 静态(增益级在此频率 |G|≈3.8,±1V 输入深入削波区);跑两个完整周期测第二个
  const per = FS / 4;
  let maxPos = 0, maxNeg = 0;
  let prevOut = 0, maxSlopeJump = 0;
  for (let i = 0; i < per * 2; i++) {
    const out = c.process(1 * Math.sin((2 * Math.PI * i) / per));
    if (i >= per) {
      maxPos = Math.max(maxPos, out);
      maxNeg = Math.min(maxNeg, out);
      maxSlopeJump = Math.max(maxSlopeJump, Math.abs(out - prevOut));
    }
    prevOut = out;
  }
  const asym = Math.abs(maxPos + maxNeg) / (maxPos - maxNeg);
  check('硬削波(峰截平在 Vf 附近,0.4~1.0V)', maxPos < 1.0 && maxPos > 0.4, `正峰=${maxPos.toFixed(3)}V`);
  check('对称削波(不对称度 < 0.02)', asym < 0.02, `asym=${asym.toFixed(4)} (pos=${maxPos.toFixed(3)} neg=${maxNeg.toFixed(3)})`);
  check('传输曲线连续(无跳变)', maxSlopeJump < 0.1, `maxJump=${maxSlopeJump.toFixed(4)}`);
}

// ---------- L2 线性区频响 ----------
console.log('L2 线性区频响(50µV 小信号,drive=0.5,对照 1.5kHz HP / 5.3kHz 摆率 LP)');
{
  // 在失真级出口直接测(OS 速率):剔除降采样 FIR(17.3kHz 截止)对 16kHz 点的衰减干扰
  const amp = 50e-6; // 峰值增益 ~820 倍 → 削波节点 ~40mV,远低于 Vf,保持线性
  const gainAt = (freq: number, filter: number) => {
    const c = new RatStage({ fs: FS });
    c.setDrive(0.5);
    c.setFilter(filter);
    const per = FS / freq; // 本组频率均整除 FS
    const n = per * Math.max(1, Math.ceil(8192 / per));
    for (let i = 0; i < FS / 2; i++) c.process(amp * Math.sin((2 * Math.PI * freq * i) / FS));
    let re = 0, im = 0;
    const w = (2 * Math.PI * freq) / FS;
    for (let i = 0; i < n; i++) {
      const out = c.process(amp * Math.sin((2 * Math.PI * freq * (i + FS / 2)) / FS));
      re += out * Math.cos(w * i);
      im -= out * Math.sin(w * i);
    }
    return (2 * Math.hypot(re, im)) / n / amp;
  };
  const freqs = [50, 100, 200, 400, 800, 1000, 2000, 3000, 4000, 6000, 8000, 16000];
  const gains = freqs.map((f) => ({ f, g: gainAt(f, 0) })); // filter=0 → 32kHz 全开
  const peak = gains.reduce((a, b) => (b.g > a.g ? b : a));
  console.log(`    增益行程: ${gains.map((x) => `${x.f}Hz:${x.g.toFixed(0)}`).join(' ')}`);
  check('高频架峰值在 2k~6k(理论 3kHz ≈ 820)', peak.f >= 2000 && peak.f <= 6000, `peak=${peak.f}Hz g=${peak.g.toFixed(0)}`);
  check('峰值增益量级(600~1100,理论 (1+50k/47)×LP)', peak.g > 600 && peak.g < 1100, `g=${peak.g.toFixed(0)}`);
  const g100 = gains.find((x) => x.f === 100)!;
  check('100Hz 衰减(1.5kHz HP 低频少增益)', peak.g / g100.g > 8, `${(20 * Math.log10(peak.g / g100.g)).toFixed(1)}dB`);
  const g16k = gains.find((x) => x.f === 16000)!;
  check('16kHz 衰减(5.3kHz 摆率 LP)', peak.g / g16k.g > 2, `${(20 * Math.log10(peak.g / g16k.g)).toFixed(1)}dB`);

  // FILTER 旋钮反向:filter=100(475Hz)时 8kHz 被压暗
  const gBright = gainAt(8000, 0);
  const gDark = gainAt(8000, 100);
  check('FILTER 反向压暗(顺时到底 8kHz 衰减 >18dB)', gBright / gDark > 8, `${(20 * Math.log10(gBright / gDark)).toFixed(1)}dB (fc=${filterToFreq(100).toFixed(0)}Hz)`);
}

// ---------- L3 非线性行为 ----------
console.log('L3 非线性行为');
{
  // THD 随 DIST 单调上升(5mV 输入,filter=0 全开避免 LP 染色谐波读数)
  const thds = [0.05, 0.2, 0.5, 1.0].map((d) => {
    const chain = makeChain(d, 0);
    const y = settleAndCapture(chain, 1000, 0.005, cycleLen(1000, 4800));
    return { d, ...thd(y, 1000) };
  });
  const mono = thds.every((t, i) => i === 0 || t.thd >= thds[i - 1].thd - 1e-6);
  check('THD 随 drive 上升', mono, thds.map((t) => `d${t.d}:${(t.thd * 100).toFixed(1)}%`).join(' '));
  const h2h3Max = Math.max(...thds.map((t) => t.h2h3));
  check('奇谐波主导(H2/H3 < 1)', h2h3Max < 1, `max H2/H3=${h2h3Max.toFixed(2)}`);

  // 频率选择性失真:1.5kHz 以下增益低 → 100Hz 削波远轻于 1kHz(RAT 签名特征)
  const thdAt = (freq: number) => {
    const chain = makeChain(0.5, 0);
    const y = settleAndCapture(chain, freq, 0.01, cycleLen(freq, 4800));
    return thd(y, freq).thd;
  };
  const t100 = thdAt(100);
  const t1k = thdAt(1000);
  check('频率选择性失真(100Hz THD ≪ 1kHz THD)', t100 < t1k * 0.7, `100Hz=${(t100 * 100).toFixed(1)}% vs 1kHz=${(t1k * 100).toFixed(1)}%`);
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项未过 ✗`);
if (failures > 0) process.exit(1);
