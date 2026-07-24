/**
 * DS-1 WDF 正确性评测(L0~L3,Node 直跑:node scripts/wdf-ds1-eval.ts)
 * 对照基准:ElectroSmash Boss DS-1 电路分析
 *   (运放级 72Hz 反馈 HP / 增益 1.47~22.7 / 1N4148 对地对称硬削 /
 *    TONE = LP 723Hz 与 HP 7.2kHz 交叉淡化,中位 ~2kHz 中频凹陷)
 */
import { Ds1ClipperStage } from '../src/audio/wdf/ds1Clipper.ts';
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from '../src/audio/wdf/resample.ts';

const BASE = 48000;
const FS = BASE * OS_FACTOR;
const T = 1 / FS;
/** 建立期:≥0.5s(覆盖输入耦合 HP 15.4Hz 的 5τ,见 wdf-whitebox-process.md §4.2) */
const SETTLE = BASE / 2;
/** 测量窗:1s = 48000 样本,任意整数 Hz 均为整周期(DFT 无泄漏,§4.3) */
const WIN = BASE;

/** 与 worklet 同构的完整 DS-1 链(输入HP → booster tanh → 削波级 → TONE 交叉淡化) */
function makeChain(dist: number, tone: number) {
  const stage = new Ds1ClipperStage({ fs: FS });
  stage.setDist(dist);
  const fir = makeAntiAliasFIR();
  const up = new Upsampler4x(fir);
  const downOut = new Decimator4x(fir);
  const downClip = new Decimator4x(fir);
  const aHpIn = T / (470e3 * 0.022e-6 + T); // 15.4Hz
  const aToneLp = T / (2.2e3 * 0.1e-6 + T); // 723Hz LP 支路
  const aToneHp = T / (2.2e3 * 0.01e-6 + T); // 7.2kHz HP 支路(x - LP)
  let hpInY1 = 0, toneLpY1 = 0, toneHpY1 = 0;
  const osBuf = new Float32Array(OS_FACTOR);
  const osOut = [0, 0, 0, 0];
  const osClip = [0, 0, 0, 0];
  return {
    stage,
    process(x: number): { out: number; clip: number } {
      up.process(osBuf, x);
      for (let k = 0; k < OS_FACTOR; k++) {
        hpInY1 += aHpIn * (osBuf[k] - hpInY1);
        const hp = osBuf[k] - hpInY1;
        const bst = 2.0 * Math.tanh(2.5 * hp); // 固定增益 5,Vsat=2V
        const s = stage.process(bst);
        toneLpY1 += aToneLp * (s - toneLpY1);
        toneHpY1 += aToneHp * (s - toneHpY1);
        osOut[k] = (1 - tone) * toneLpY1 + tone * (s - toneHpY1);
        osClip[k] = s;
      }
      return {
        out: downOut.process(osOut[0], osOut[1], osOut[2], osOut[3]),
        clip: downClip.process(osClip[0], osClip[1], osClip[2], osClip[3]),
      };
    },
  };
}

type Tap = 'out' | 'clip';

function settleAndCapture(
  chain: { process(x: number): { out: number; clip: number } },
  freq: number,
  amp: number,
  tap: Tap,
): Float64Array {
  for (let i = 0; i < SETTLE; i++) chain.process(amp * Math.sin((2 * Math.PI * freq * i) / BASE));
  const out = new Float64Array(WIN);
  for (let i = 0; i < WIN; i++) {
    out[i] = chain.process(amp * Math.sin((2 * Math.PI * freq * (i + SETTLE)) / BASE))[tap];
  }
  return out;
}

/** 单频点幅度(Goertzel,整数 Hz 在 1s 窗内为整周期) */
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
  const c = new Ds1ClipperStage({ fs: FS });
  c.setDist(0.8);
  let nan = 0, maxAbs = 0;
  for (let i = 0; i < FS / 2; i++) {
    const out = c.process(2 * Math.sin((2 * Math.PI * 1000 * i) / FS));
    if (!Number.isFinite(out)) nan++;
    maxAbs = Math.max(maxAbs, Math.abs(out));
  }
  check('无 NaN', nan === 0, `nan=${nan}`);
  check('输出有界(对地削波 < 5V)', maxAbs < 5, `maxAbs=${maxAbs.toFixed(2)}`);
  const avgIter = c.iterTotal / Math.max(1, c.iterCount);
  check('Newton 收敛(平均 <10 次)', avgIter < 10, `avg=${avgIter.toFixed(1)}`);

  const c2 = new Ds1ClipperStage({ fs: FS });
  let silentMax = 0;
  for (let i = 0; i < FS / 10; i++) silentMax = Math.max(silentMax, Math.abs(c2.process(0)));
  check('静音→静音(无极限环)', silentMax < 1e-9, `silentMax=${silentMax.toExponential(1)}`);

  // 全链热信号有界性(dist/tone 全开,0.5V 输入)
  const chain = makeChain(1, 1);
  let chainMax = 0, chainNan = 0;
  for (let i = 0; i < BASE / 2; i++) {
    const { out } = chain.process(0.5 * Math.sin((2 * Math.PI * 1000 * i) / BASE));
    if (!Number.isFinite(out)) chainNan++;
    chainMax = Math.max(chainMax, Math.abs(out));
  }
  check('全链无 NaN 且有界', chainNan === 0 && chainMax < 2, `nan=${chainNan} maxAbs=${chainMax.toFixed(3)}`);
}

// ---------- L1 静态传输特性 ----------
console.log('L1 静态传输特性(慢扫,削波级)');
{
  const c = new Ds1ClipperStage({ fs: FS });
  c.setDist(0.5);
  // 1Hz 慢扫 ≈ 静态;跑两个完整周期,测最后一个整周期
  let maxPos = 0, maxNeg = 0;
  let prevOut = 0, maxSlopeJump = 0;
  for (let i = 0; i < BASE * 2; i++) {
    const ph = (2 * Math.PI * i) / BASE; // 1Hz
    const out = c.process(1 * Math.sin(ph));
    if (i >= BASE) {
      maxPos = Math.max(maxPos, out);
      maxNeg = Math.min(maxNeg, out);
      maxSlopeJump = Math.max(maxSlopeJump, Math.abs(out - prevOut));
    }
    prevOut = out;
  }
  const asym = Math.abs(maxPos + maxNeg) / (maxPos - maxNeg);
  check('硬削波(峰被压在硅管 Vf ≈ 0.6V 附近)', maxPos > 0.4 && maxPos < 1.0, `正峰=${maxPos.toFixed(2)}V`);
  check('对称削波(不对称度 < 0.02)', asym < 0.02, `asym=${asym.toFixed(4)} (pos=${maxPos.toFixed(2)} neg=${maxNeg.toFixed(2)})`);
  check('传输曲线连续(无跳变)', maxSlopeJump < 0.1, `maxJump=${maxSlopeJump.toFixed(4)}`);
}

// ---------- L2 线性区频响 ----------
console.log('L2 线性区频响(小信号,对照 72Hz HP / 723Hz LP / 7.2kHz HP)');
{
  // amp 选取保证二极管不导通(线性区):vOp 峰值 = amp·5·(1+Rf/R12) << 0.55V
  const gainAt = (tone: number, freq: number, dist = 0, amp = 0.01): number => {
    const chain = makeChain(dist, tone);
    const y = settleAndCapture(chain, freq, amp, 'out');
    return goertzel(y, freq) / amp;
  };
  // TONE=0:LP 支路(723Hz)主导 → 高频衰减
  const gLp200 = gainAt(0, 200);
  const gLp6k = gainAt(0, 6000);
  check('TONE=0 为低通(200Hz/6kHz > 6)', gLp200 / gLp6k > 6, `比值=${(gLp200 / gLp6k).toFixed(1)}`);
  // TONE=1:HP 支路(7.2kHz)主导 → 低频衰减
  const gHp10k = gainAt(1, 10000);
  const gHp500 = gainAt(1, 500);
  check('TONE=1 为高通(10kHz/500Hz > 6)', gHp10k / gHp500 > 6, `比值=${(gHp10k / gHp500).toFixed(1)}`);
  // TONE=0.5:两支路交叉淡化 → 中频凹陷(凹陷谷 ~2.2kHz)
  const gMid = gainAt(0.5, 2200);
  const gBass = gainAt(0.5, 200);
  const gTreb = gainAt(0.5, 8000);
  check(
    'TONE 中位中频凹陷(2.2kHz 低于两端 6dB+)',
    gMid < 0.5 * gBass && gMid < 0.5 * gTreb,
    `2.2k/200=${(gMid / gBass).toFixed(2)} 2.2k/8k=${(gMid / gTreb).toFixed(2)}`,
  );
  // 运放级反馈 HP:DC 增益为 1(C8 隔断),72Hz 极点以上升至 1+Rf/R12。
  // dist=0.3(增益步进 1→7.85,仍在线性区:vOp 峰值 0.39V < 0.55V)
  const g500 = gainAt(0, 500, 0.3);
  const g20 = gainAt(0, 20, 0.3);
  check('运放级 72Hz 反馈 HP(500Hz/20Hz > 2.5)', g500 / g20 > 2.5, `比值=${(g500 / g20).toFixed(2)}`);
  // 反馈 C7:DIST 越大,反馈低通越低(723kHz → 15.6kHz)。
  // 1mV 输入保证 dist=1 仍为线性区(vOp 峰值 0.11V);15k/1k 比值中 FIR 衰减在 dist 间对消。
  const r = (dist: number) => gainAt(1, 15000, dist, 0.001) / gainAt(1, 1000, dist, 0.001);
  const r0 = r(0), r1 = r(1);
  check('DIST 反馈低通随增益下移(15k/1k 比值下降)', r1 < 0.9 * r0, `dist0=${r0.toFixed(2)} dist1=${r1.toFixed(2)}`);
}

// ---------- L3 非线性行为 ----------
console.log('L3 非线性行为');
{
  // THD 随 DIST 单调上升(50mV 输入,削波级出口测量,剔除 TONE 对谐波的再塑造)
  const thds = [0.1, 0.3, 0.6, 1.0].map((d) => {
    const chain = makeChain(d, 0.5);
    const y = settleAndCapture(chain, 1000, 0.05, 'clip');
    return { d, ...thd(y, 1000) };
  });
  const mono = thds.every((t, i) => i === 0 || t.thd >= thds[i - 1].thd - 1e-6);
  check('THD 随 dist 上升', mono, thds.map((t) => `d${t.d}:${(t.thd * 100).toFixed(1)}%`).join(' '));
  const h2h3Max = Math.max(...thds.map((t) => t.h2h3));
  check('奇谐波主导(H2/H3 < 1)', h2h3Max < 1, `max H2/H3=${h2h3Max.toFixed(2)}`);

  // TONE 塑造失真谐波:HP 支路保留高次谐波 → 同一削波下 TONE=1 的表观 THD 更高
  const thdAtTone = (tone: number) => {
    const chain = makeChain(0.7, tone);
    const y = settleAndCapture(chain, 1000, 0.05, 'out');
    return thd(y, 1000).thd;
  };
  const tDark = thdAtTone(0);
  const tBright = thdAtTone(1);
  check(
    'TONE 控制谐波含量(THD: TONE=1 > TONE=0)',
    tBright > tDark,
    `TONE=0:${(tDark * 100).toFixed(1)}% vs TONE=1:${(tBright * 100).toFixed(1)}%`,
  );
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项未过 ✗`);
if (failures > 0) process.exit(1);
