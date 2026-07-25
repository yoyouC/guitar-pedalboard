/**
 * LA-2A 光学压缩正确性评测(L0~L2,Node 直跑:node scripts/wdf-la2a-eval.ts)
 * 对照基准:Teletronix LA-2A 公开特性——
 *   软拐点、Compress ≈3:1 / Limit ≈10:1;
 *   T4B 光电池程序相关释放:短瞬态 ~50-70ms 快释放,持续音两段式(先快后慢 ~1-2s)。
 */
import { La2aOptoComp } from '../src/audio/wdf/la2aOpto.ts';

const FS = 48000;
const FREQ = 1000;

function lin(dbv: number): number {
  return Math.pow(10, dbv / 20);
}

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}: ${detail}`);
  if (!ok) failures++;
}

/** 静态测量:3s 建立期(≫ slow 支路 5τ)后读稳态 grDb 均值,并用输出 RMS 交叉验证 */
function measureStatic(mode: number, reduction: number, inDb: number): { gr: number; grCross: number } {
  const c = new La2aOptoComp({ fs: FS });
  c.setMode(mode);
  c.setReduction(reduction);
  const amp = lin(inDb);
  const settleN = FS * 3;
  for (let i = 0; i < settleN; i++) c.process(amp * Math.sin((2 * Math.PI * FREQ * i) / FS));
  let grSum = 0, sumSq = 0;
  const n = Math.floor(FS * 0.04);
  for (let i = 0; i < n; i++) {
    const y = c.process(amp * Math.sin((2 * Math.PI * FREQ * (settleN + i)) / FS));
    grSum += c.grDb;
    sumSq += y * y;
  }
  const outDb = 20 * Math.log10(Math.sqrt(sumSq / n)) + 3.0103; // 正弦 RMS → 峰值 dB
  return { gr: grSum / n, grCross: inDb - outDb };
}

/** 释放测量:1kHz -6dBFS 持续 durS 后切静音,逐样本读 grDb 的 t37/t50/t10 */
function releaseTest(durS: number): { G0: number; t37: number; t50: number; t10: number; grEnd: number } {
  const c = new La2aOptoComp({ fs: FS });
  c.setReduction(70);
  c.setMode(0);
  const amp = lin(-6);
  const nOn = Math.floor(durS * FS);
  let G0 = 0;
  for (let i = 0; i < nOn; i++) {
    c.process(amp * Math.sin((2 * Math.PI * FREQ * i) / FS));
    if (i >= nOn - Math.floor(FS * 0.005)) G0 = Math.max(G0, c.grDb);
  }
  let t37 = -1, t50 = -1, t10 = -1;
  const nOff = 6 * FS;
  for (let i = 0; i < nOff; i++) {
    c.process(0);
    const t = (i + 1) / FS;
    if (t37 < 0 && c.grDb <= G0 / Math.E) t37 = t;
    if (t50 < 0 && c.grDb <= G0 / 2) t50 = t;
    if (t10 < 0 && c.grDb <= G0 * 0.1) t10 = t;
  }
  return { G0, t37, t50, t10, grEnd: c.grDb };
}

// ---------- L0 求解器健康 ----------
console.log('L0 求解器健康');
{
  const c = new La2aOptoComp({ fs: FS });
  c.setReduction(90);
  let nan = 0, maxAbs = 0;
  for (let i = 0; i < FS; i++) {
    const y = c.process(0.9 * Math.sin((2 * Math.PI * FREQ * i) / FS));
    if (!Number.isFinite(y)) nan++;
    maxAbs = Math.max(maxAbs, Math.abs(y));
  }
  check('无 NaN', nan === 0, `nan=${nan}`);
  check('深压缩输出有界', maxAbs < 1.2, `maxAbs=${maxAbs.toFixed(3)}`);

  const c2 = new La2aOptoComp({ fs: FS });
  let silentMax = 0;
  for (let i = 0; i < FS / 10; i++) silentMax = Math.max(silentMax, Math.abs(c2.process(0)));
  check('静音→静音(无极限环)', silentMax < 1e-9, `silentMax=${silentMax.toExponential(1)}`);

  // 参数全程扫掠:reduction 往返扫、mode 切换、makeup 扫、输入电平跳变
  const c3 = new La2aOptoComp({ fs: FS });
  let nan3 = 0, maxAbs3 = 0;
  const N = FS * 8;
  for (let i = 0; i < N; i++) {
    const t = i / FS;
    const lvl = [-60, -24, -12, -6, -30, -18, -40, -10][Math.floor(t) % 8];
    const x = lin(lvl) * Math.sin(2 * Math.PI * FREQ * t);
    c3.setReduction(50 + 50 * Math.sin(2 * Math.PI * 0.5 * t));
    c3.setMode(Math.floor(t / 0.7) % 2);
    c3.setMakeupGain(lin(15 + 15 * Math.sin(2 * Math.PI * 0.3 * t)));
    const y = c3.process(x);
    if (!Number.isFinite(y)) nan3++;
    maxAbs3 = Math.max(maxAbs3, Math.abs(y));
  }
  check('参数全程扫掠无 NaN', nan3 === 0, `nan=${nan3}`);
  check('参数扫掠输出有界', maxAbs3 < 40, `maxAbs=${maxAbs3.toFixed(2)}`);
}

// ---------- L1 静态压缩曲线 ----------
console.log('L1 静态压缩曲线(3s 建立,逐点读稳态 grDb)');
{
  const inDbs: number[] = [];
  for (let d = -60; d <= -6; d += 3) inDbs.push(d);

  const curve = (mode: number) =>
    inDbs.map((d) => {
      const { gr, grCross } = measureStatic(mode, 70, d);
      return { inDb: d, gr, outDb: d - gr, grCross };
    });

  const comp = curve(0);
  const crossErr = Math.max(...comp.map((p) => Math.abs(p.gr - p.grCross)));
  check('grDb 与输出 RMS 交叉一致(<0.6dB)', crossErr < 0.6, `maxErr=${crossErr.toFixed(3)}dB`);

  // 深压区(in ∈ [-18,-6],over ≥ 9.4dB,全在线性段)最小二乘斜率 = 1/R
  const fit = (pts: { inDb: number; outDb: number }[]) => {
    const mX = pts.reduce((s, p) => s + p.inDb, 0) / pts.length;
    const mY = pts.reduce((s, p) => s + p.outDb, 0) / pts.length;
    let num = 0, den = 0;
    for (const p of pts) {
      num += (p.inDb - mX) * (p.outDb - mY);
      den += (p.inDb - mX) ** 2;
    }
    return num / den;
  };
  const deep = comp.filter((p) => p.inDb >= -18);
  const slopeC = fit(deep);
  check('Compress 深压斜率 ≈ 1/3([0.30,0.37])', slopeC >= 0.3 && slopeC <= 0.37, `slope=${slopeC.toFixed(3)} (R=${(1 / slopeC).toFixed(2)})`);

  const lim = curve(1);
  const slopeL = fit(lim.filter((p) => p.inDb >= -18));
  check('Limit 深压斜率 ≈ 1/10([0.08,0.12])', slopeL >= 0.08 && slopeL <= 0.12, `slope=${slopeL.toFixed(3)} (R=${(1 / slopeL).toFixed(2)})`);

  // 软拐点:差分斜率从 ~1.0(阈值下 1:1)单调渐降至深压值 1/R,无跳变
  const segSlopes = comp.slice(1).map((p, i) => (p.outDb - comp[i].outDb) / (p.inDb - comp[i].inDb));
  const mono = segSlopes.every((s, i) => i === 0 || s <= segSlopes[i - 1] + 0.02);
  const maxJump = Math.max(...segSlopes.slice(1).map((s, i) => Math.abs(s - segSlopes[i])));
  check('软拐点(差分斜率单调渐降 1.0→1/R)', mono && segSlopes[0] > 0.9 && segSlopes[segSlopes.length - 1] >= 0.3 && segSlopes[segSlopes.length - 1] <= 0.37,
    `start=${segSlopes[0].toFixed(3)} end=${segSlopes[segSlopes.length - 1].toFixed(3)} mono=${mono}`);
  check('曲线无跳变(相邻斜率差 ≤0.2)', maxJump <= 0.2, `maxJump=${maxJump.toFixed(3)}`);
  const outMono = comp.every((p, i) => i === 0 || p.outDb >= comp[i - 1].outDb - 0.05);
  check('输出随输入单调不减', outMono, `outMono=${outMono}`);

  // REDUCTION 单调控制压缩量
  const grs = [0, 20, 40, 60, 80, 100].map((r) => measureStatic(0, r, -12).gr);
  const grMono = grs.every((g, i) => i === 0 || g >= grs[i - 1] - 0.05);
  check('压缩量随 REDUCTION 单调', grMono, grs.map((g) => g.toFixed(1)).join(' → '));
  check('REDUCTION=0 不压缩 / =100 深压缩', grs[0] < 0.1 && grs[5] > 15, `gr(0)=${grs[0].toFixed(2)}dB gr(100)=${grs[5].toFixed(1)}dB`);
}

// ---------- L2 动态行为(T4B 程序相关释放) ----------
console.log('L2 动态行为');
{
  const short = releaseTest(0.04); // 40ms 瞬态短音
  check('短促 burst 产生有效压缩(G0>6dB)', short.G0 > 6, `G0=${short.G0.toFixed(1)}dB`);
  check('短促 burst 快释放 t37 ∈ [35,100]ms(目标 ~50-70ms)',
    short.t37 >= 0.035 && short.t37 <= 0.1, `t37=${(short.t37 * 1000).toFixed(1)}ms`);

  const long = releaseTest(2); // 2s 持续音
  check('持续音释放第一段快(t50 < 150ms)', long.t50 >= 0 && long.t50 < 0.15, `t50=${(long.t50 * 1000).toFixed(1)}ms`);
  check('持续音释放第二段慢尾 t10 ∈ [0.8,4.0]s(目标 ~1-2s)',
    long.t10 >= 0.8 && long.t10 <= 4.0, `t10=${long.t10.toFixed(2)}s`);
  check('两段式释放(t10/t50 > 6,单指数上限 3.33)', long.t10 / long.t50 > 6,
    `比值=${(long.t10 / long.t50).toFixed(1)}`);
  check('短音释放 < 持续音的 1/2', short.t37 < 0.5 * long.t10,
    `short=${(short.t37 * 1000).toFixed(0)}ms vs long/2=${(long.t10 / 2).toFixed(2)}s`);
  check('光记忆可恢复(6s 后 grDb < 0.5dB)', long.grEnd < 0.5, `grEnd=${long.grEnd.toFixed(3)}dB`);

  // GAIN 补偿:无压缩时(reduction=0)输出 = 输入 × makeup
  const c = new La2aOptoComp({ fs: FS });
  c.setReduction(0);
  c.setMakeupGain(lin(6));
  const amp = lin(-40);
  let sumSq = 0;
  const n = FS;
  for (let i = 0; i < n; i++) {
    const y = c.process(amp * Math.sin((2 * Math.PI * FREQ * i) / FS));
    if (i >= n / 2) sumSq += y * y;
  }
  const gainDb = 20 * Math.log10(Math.sqrt(sumSq / (n / 2)) / (amp / Math.SQRT2));
  check('GAIN 补偿准确(+6dB ±0.15dB)', Math.abs(gainDb - 6) < 0.15, `实测=+${gainDb.toFixed(2)}dB`);
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项未过 ✗`);
if (failures > 0) process.exit(1);
