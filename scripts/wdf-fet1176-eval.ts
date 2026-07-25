/**
 * FET 压缩(1176 风格)正确性评测(L0~L3,Node 直跑:node scripts/wdf-fet1176-eval.ts)
 * 对照基准:UREI 1176 规格(启动 20~800µs / 释放 50ms~1.1s / 比率 4/8/12/20:1 /
 * all-buttons-in 高压限+FET 饱和失真)。
 *
 * 测量约定:
 * - 启动/释放时间用 DC 阶跃(检测路径无纹波),63.2% / 36.8% 交点线性内插;
 * - 静态比率曲线用 DC 电平扫描(精确),另用 1kHz 正弦 + 快启动/慢释放(峰值贴轨)抽点;
 * - 频谱测量一律整数周期窗 + Goertzel(见 docs/wdf-whitebox-process.md §4.3)。
 */
import { FetCompressor } from '../src/audio/wdf/fetComp.ts';

const FS = 48000;

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}: ${detail}`);
  if (!ok) failures++;
}

function db(lin: number): number {
  return 20 * Math.log10(Math.max(1e-9, lin));
}

/** 单频点幅度(Goertzel,窗长须为信号整周期) */
function goertzel(y: Float64Array, freq: number): number {
  const N = y.length;
  const w = (2 * Math.PI * freq) / FS;
  let re = 0, im = 0;
  for (let n = 0; n < N; n++) {
    re += y[n] * Math.cos(w * n);
    im -= y[n] * Math.sin(w * n);
  }
  return (2 * Math.hypot(re, im)) / N;
}

/** 确定性伪随机噪声(LCG,[-1,1)) */
let seed = 12345;
function noise(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x40000000 - 1;
}

/** 上升沿 63.2% 交点(样本间线性内插),返回秒;未达返回 Infinity */
function timeToFracUp(gr: number[], frac: number): number {
  const target = frac * gr[gr.length - 1];
  for (let i = 1; i < gr.length; i++) {
    if (gr[i] >= target) {
      const f = (target - gr[i - 1]) / (gr[i] - gr[i - 1]);
      return (i - 1 + f) / FS;
    }
  }
  return Infinity;
}

/** 下降沿衰减到 36.8% 交点(内插),返回秒;未达返回 Infinity */
function timeToFracDown(gr: number[], frac: number): number {
  const target = frac * gr[0];
  for (let i = 1; i < gr.length; i++) {
    if (gr[i] <= target) {
      const f = (gr[i - 1] - target) / (gr[i - 1] - gr[i]);
      return (i - 1 + f) / FS;
    }
  }
  return Infinity;
}

// ---------- L0 健康 ----------
console.log('L0 健康(无 NaN / 有界 / 静音→静音 / 参数扫掠)');
{
  const c = new FetCompressor({ fs: FS });
  let nan = 0, maxAbs = 0;
  for (let i = 0; i < FS; i++) {
    const out = c.process(0.5 * Math.sin((2 * Math.PI * 1000 * i) / FS));
    if (!Number.isFinite(out)) nan++;
    maxAbs = Math.max(maxAbs, Math.abs(out));
  }
  check('无 NaN', nan === 0, `nan=${nan}`);
  check('输出有界(<10)', maxAbs < 10, `maxAbs=${maxAbs.toFixed(3)}`);

  const c2 = new FetCompressor({ fs: FS });
  let silentMax = 0;
  for (let i = 0; i < FS / 5; i++) silentMax = Math.max(silentMax, Math.abs(c2.process(0)));
  check('静音→静音(无极限环)', silentMax < 1e-9, `silentMax=${silentMax.toExponential(1)}`);

  // 参数全程扫掠(噪声 ±1 满幅输入):ratio × attack × release 网格 + threshold/level 扫描
  let sweepBad = 0, sweepMax = 0;
  for (let r = 0; r <= 4; r++) {
    for (const atk of [20, 200, 800]) {
      for (const rel of [50, 300, 1100]) {
        const cc = new FetCompressor({ fs: FS });
        cc.setThresholdDb(-30);
        cc.setRatioIndex(r);
        cc.setAttackUs(atk);
        cc.setReleaseMs(rel);
        cc.setLevelGain(2);
        for (let i = 0; i < 4096; i++) {
          const out = cc.process(noise());
          if (!Number.isFinite(out)) sweepBad++;
          sweepMax = Math.max(sweepMax, Math.abs(out));
        }
      }
    }
  }
  for (const thr of [-60, -45, -30, -15, 0]) {
    const cc = new FetCompressor({ fs: FS });
    cc.setThresholdDb(thr);
    cc.setRatioIndex(3);
    cc.setAttackUs(20);
    cc.setReleaseMs(50);
    for (let i = 0; i < 4096; i++) {
      const out = cc.process(noise());
      if (!Number.isFinite(out)) sweepBad++;
      sweepMax = Math.max(sweepMax, Math.abs(out));
    }
  }
  check('参数全程扫掠稳定(无 NaN)', sweepBad === 0, `bad=${sweepBad}`);
  check('扫掠输出有界(<10)', sweepMax < 10, `maxAbs=${sweepMax.toFixed(3)}`);
}

// ---------- L1 特征指标 ----------
console.log('L1 特征指标(启动/释放时间、静态比率曲线)');
{
  // 启动时间:DC 阶跃 0.05(-26dB,阈下)→ 0.5(-6dB,超阈),thr=-20dB,R=4
  const attacks = [20, 60, 200, 800];
  const atkResults: string[] = [];
  let atkOk = true;
  for (const tauUs of attacks) {
    const c = new FetCompressor({ fs: FS });
    c.setThresholdDb(-20);
    c.setRatioIndex(0);
    c.setAttackUs(tauUs);
    c.setReleaseMs(500);
    for (let i = 0; i < FS * 0.2; i++) c.process(0.05);
    const nMeas = Math.ceil(FS * (8 * tauUs * 1e-6 + 0.002));
    const gr: number[] = [c.grDb]; // t=0 起点
    for (let i = 0; i < nMeas; i++) {
      c.process(0.5);
      gr.push(c.grDb);
    }
    const tMeas = timeToFracUp(gr, 0.632) * 1e6;
    const err = (tMeas - tauUs) / tauUs;
    if (Math.abs(err) > 0.2) atkOk = false;
    atkResults.push(`${tauUs}µs→${tMeas.toFixed(1)}µs(${(err * 100).toFixed(1)}%)`);
  }
  check('启动时间随 ATTACK ±20%', atkOk, atkResults.join(' '));

  // 释放时间:0.5 建立 → 0.05,GR 衰减到 36.8%
  const releases = [50, 200, 1100];
  const relResults: string[] = [];
  let relOk = true;
  for (const tauMs of releases) {
    const c = new FetCompressor({ fs: FS });
    c.setThresholdDb(-20);
    c.setRatioIndex(0);
    c.setAttackUs(20);
    c.setReleaseMs(tauMs);
    for (let i = 0; i < FS * 4 * (tauMs / 1000); i++) c.process(0.5);
    const nMeas = Math.ceil(FS * 1.6 * (tauMs / 1000));
    const gr: number[] = [c.grDb]; // t=0 起点
    for (let i = 0; i < nMeas; i++) {
      c.process(0.05);
      gr.push(c.grDb);
    }
    const tMeas = timeToFracDown(gr, 0.368) * 1e3;
    const err = (tMeas - tauMs) / tauMs;
    if (Math.abs(err) > 0.2) relOk = false;
    relResults.push(`${tauMs}ms→${tMeas.toFixed(1)}ms(${(err * 100).toFixed(1)}%)`);
  }
  check('释放时间随 RELEASE ±20%', relOk, relResults.join(' '));

  // 静态比率曲线(DC 电平扫描,thr=-30dB):测输出电平 vs 理想曲线,1dB 判据
  const ratios: [number, number][] = [[0, 4], [1, 8], [2, 12], [3, 20]];
  const ratioDetail: string[] = [];
  let ratioOk = true;
  for (const [idx, R] of ratios) {
    const c = new FetCompressor({ fs: FS });
    c.setThresholdDb(-30);
    c.setRatioIndex(idx);
    c.setAttackUs(200);
    c.setReleaseMs(100);
    let maxErr = 0;
    for (let inDb = -45; inDb <= -5; inDb += 5) {
      const amp = Math.pow(10, inDb / 20);
      for (let i = 0; i < FS; i++) c.process(amp); // 1s 建立
      let acc = 0;
      const nAvg = FS / 10;
      for (let i = 0; i < nAvg; i++) acc += Math.abs(c.process(amp));
      const outDb = db(acc / nAvg);
      const ideal = inDb <= -30 ? inDb : -30 + (inDb + 30) / R;
      maxErr = Math.max(maxErr, Math.abs(outDb - ideal));
    }
    if (maxErr > 1.0) ratioOk = false;
    ratioDetail.push(`${R}:1 maxErr=${maxErr.toFixed(2)}dB`);
  }
  check('比率曲线吻合(全档 1dB 内)', ratioOk, ratioDetail.join(' '));

  // ALL 档压限:超阈输出被压回阈值附近
  {
    const c = new FetCompressor({ fs: FS });
    c.setThresholdDb(-30);
    c.setRatioIndex(4);
    c.setAttackUs(200);
    c.setReleaseMs(100);
    let maxDev = 0;
    for (let inDb = -25; inDb <= -5; inDb += 5) {
      const amp = Math.pow(10, inDb / 20);
      for (let i = 0; i < FS; i++) c.process(amp);
      let acc = 0;
      const nAvg = FS / 10;
      for (let i = 0; i < nAvg; i++) acc += Math.abs(c.process(amp));
      maxDev = Math.max(maxDev, Math.abs(db(acc / nAvg) - -30));
    }
    check('ALL 档压限(输出≈阈值 ±1.5dB)', maxDev <= 1.5, `maxDev=${maxDev.toFixed(2)}dB`);
  }

  // 正弦抽点:1kHz -10dBFS,R=8,快启动+慢释放(峰值贴轨),理想 -27.5dB
  {
    const c = new FetCompressor({ fs: FS });
    c.setThresholdDb(-30);
    c.setRatioIndex(1);
    c.setAttackUs(20);
    c.setReleaseMs(1100);
    const amp = Math.pow(10, -10 / 20);
    for (let i = 0; i < FS * 2; i++) c.process(amp * Math.sin((2 * Math.PI * 1000 * i) / FS));
    const n = 48 * 48; // 48 整周期
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) y[i] = c.process(amp * Math.sin((2 * Math.PI * 1000 * (i + FS * 2)) / FS));
    const outDb = db(goertzel(y, 1000));
    check('1kHz 正弦压缩量吻合(R=8,±1dB)', Math.abs(outDb - -27.5) <= 1.0, `out=${outDb.toFixed(2)}dB(理想 -27.5dB)`);
  }
}

// ---------- L2 行为特征 ----------
console.log('L2 行为特征(GR 单调性、ALL 更深、超快启动压瞬态)');
{
  // GR 随输入电平单调上升
  const c = new FetCompressor({ fs: FS });
  c.setThresholdDb(-30);
  c.setRatioIndex(1);
  c.setAttackUs(200);
  c.setReleaseMs(100);
  const grs: number[] = [];
  for (let inDb = -50; inDb <= -5; inDb += 5) {
    const amp = Math.pow(10, inDb / 20);
    for (let i = 0; i < FS / 2; i++) c.process(amp);
    grs.push(c.grDb);
  }
  const mono = grs.every((g, i) => i === 0 || g >= grs[i - 1] - 1e-9);
  const strict = grs[grs.length - 1] > grs[3] + 1;
  check('GR 随输入电平单调上升', mono && strict, `grDb=[${grs.map((g) => g.toFixed(1)).join(',')}]`);

  // ALL 档 GR 深于 20:1
  const grAt = (idx: number) => {
    const cc = new FetCompressor({ fs: FS });
    cc.setThresholdDb(-30);
    cc.setRatioIndex(idx);
    cc.setAttackUs(200);
    cc.setReleaseMs(100);
    for (let i = 0; i < FS / 2; i++) cc.process(0.5);
    return cc.grDb;
  };
  const gr20 = grAt(3), grAll = grAt(4);
  check('ALL 档 GR 深于 20:1', grAll > gr20, `20:1=${gr20.toFixed(1)}dB ALL=${grAll.toFixed(1)}dB`);

  // 超快启动压瞬态:1kHz 突发,20µs vs 800µs 的首 1ms 峰值
  const burstPeak = (atkUs: number) => {
    const cc = new FetCompressor({ fs: FS });
    cc.setThresholdDb(-30);
    cc.setRatioIndex(3);
    cc.setAttackUs(atkUs);
    cc.setReleaseMs(500);
    for (let i = 0; i < FS / 5; i++) cc.process(0);
    let peak = 0;
    for (let i = 0; i < FS / 1000; i++) {
      peak = Math.max(peak, Math.abs(cc.process(0.5 * Math.sin((2 * Math.PI * 1000 * i) / FS))));
    }
    return peak;
  };
  const pFast = burstPeak(20), pSlow = burstPeak(800);
  check('超快启动压瞬态(20µs 首 1ms 峰值 ≪ 800µs)', pFast < 0.3 * pSlow, `20µs=${pFast.toFixed(3)} 800µs=${pSlow.toFixed(3)}`);
}

// ---------- L3 非线性行为 ----------
console.log('L3 非线性行为(高比率失真、ALL 重饱和、阈下近透明)');
{
  // 50Hz、-6dBFS,thr=-30dB,attack 20µs,release 50ms
  // (低频 + 快释放 → GR 纹波深,增益调制失真最强,1176 的典型失真区)
  const FREQ = 50;
  const harmonics = (ratioIdx: number) => {
    const c = new FetCompressor({ fs: FS });
    c.setThresholdDb(-30);
    c.setRatioIndex(ratioIdx);
    c.setAttackUs(20);
    c.setReleaseMs(50);
    for (let i = 0; i < FS; i++) c.process(0.5 * Math.sin((2 * Math.PI * FREQ * i) / FS));
    const n = (FS / FREQ) * 50; // 50 整周期
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) y[i] = c.process(0.5 * Math.sin((2 * Math.PI * FREQ * (i + FS)) / FS));
    const h1 = goertzel(y, FREQ);
    const h2 = goertzel(y, FREQ * 2);
    const h3 = goertzel(y, FREQ * 3);
    const h4 = goertzel(y, FREQ * 4);
    const h5 = goertzel(y, FREQ * 5);
    const thd = Math.sqrt(h2 * h2 + h3 * h3 + h4 * h4 + h5 * h5) / h1;
    return { h1, h2: h2 / h1, h3: h3 / h1, thd };
  };
  const m20 = harmonics(3);
  check('高比率有明显 THD(20:1,≥3%)', m20.thd >= 0.03, `THD=${(m20.thd * 100).toFixed(1)}%`);
  check('高比率有 H2(20:1,≥0.5%)', m20.h2 >= 0.005, `H2=${(m20.h2 * 100).toFixed(2)}%`);
  check('高比率有 H3(20:1,≥1%)', m20.h3 >= 0.01, `H3=${(m20.h3 * 100).toFixed(2)}%`);

  const mAll = harmonics(4);
  check('ALL 档失真重于 20:1', mAll.thd > m20.thd * 1.2, `ALL=${(mAll.thd * 100).toFixed(1)}% vs 20:1=${(m20.thd * 100).toFixed(1)}%`);
  check('ALL 档 H2 重于 20:1(重饱和)', mAll.h2 > m20.h2, `ALL=${(mAll.h2 * 100).toFixed(2)}% vs 20:1=${(m20.h2 * 100).toFixed(2)}%`);

  // 阈下小信号:仅轻微饱和,近透明
  {
    const c = new FetCompressor({ fs: FS });
    c.setThresholdDb(-20);
    c.setRatioIndex(0);
    for (let i = 0; i < FS; i++) c.process(0.05 * Math.sin((2 * Math.PI * 1000 * i) / FS));
    const n = 48 * 50;
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) y[i] = c.process(0.05 * Math.sin((2 * Math.PI * 1000 * (i + FS)) / FS));
    const h1 = goertzel(y, 1000);
    const thd = Math.sqrt(goertzel(y, 2000) ** 2 + goertzel(y, 3000) ** 2 + goertzel(y, 4000) ** 2 + goertzel(y, 5000) ** 2) / h1;
    check('阈下近透明(THD<0.5%)', thd < 0.005, `THD=${(thd * 100).toFixed(3)}%`);
  }
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项未过 ✗`);
if (failures > 0) process.exit(1);
