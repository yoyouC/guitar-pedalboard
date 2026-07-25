/**
 * 乒乓延迟(Ping-Pong Delay)正确性评测(L0~L2,Node 直跑:node scripts/wdf-pingpong-eval.ts)
 * 对照基准:经典乒乓路由 —— 输入求和注入 L 侧延迟线,交叉耦合双延迟线使回声
 * 在 L/R 严格交替;第 k 次回声位于 k·TIME、幅度 ∝ fb^(k-1);反馈路径一阶低通
 * (3.5kHz)使重复渐暗。全线性,无时变元件,故无需 DFT 整数周期窗,
 * 全部用窗内能量/RMS/峰值位置度量;参数变更后照例跑 ≥0.5s 建立期(§4.2)。
 */
import { PingPongDelay, PINGPONG_LP_FC } from '../src/audio/wdf/pingPongDelay.ts';

const FS = 48000;

function makeCore(timeMs: number, fbPct: number, mixPct: number): PingPongDelay {
  const c = new PingPongDelay({ fs: FS });
  c.setTimeMs(timeMs);
  c.setFeedback(fbPct / 100);
  c.setMix(mixPct / 100);
  return c;
}

interface Stereo {
  l: Float64Array;
  r: Float64Array;
}

function runStereo(c: PingPongDelay, inL: Float64Array, inR: Float64Array): Stereo {
  const l = new Float64Array(inL.length);
  const r = new Float64Array(inL.length);
  for (let i = 0; i < inL.length; i++) {
    c.process(inL[i], inR[i]);
    l[i] = c.outL;
    r[i] = c.outR;
  }
  return { l, r };
}

/** 建立期:喂 zeros(线性系统零状态即稳态,惯例仍跑 ≥0.5s) */
function settle(c: PingPongDelay, seconds: number): void {
  const n = Math.round(seconds * FS);
  for (let i = 0; i < n; i++) c.process(0, 0);
}

function hannBurst(freq: number, ms: number, amp: number): Float64Array {
  const n = Math.round((ms / 1000) * FS);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    out[i] = amp * Math.sin((2 * Math.PI * freq * i) / FS) * w;
  }
  return out;
}

function energy(y: Float64Array, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += y[i] * y[i];
  return s;
}

function rms(y: Float64Array, from: number, to: number): number {
  return Math.sqrt(energy(y, from, to) / (to - from));
}

function argmaxAbs(y: Float64Array, from: number, to: number): number {
  let best = from;
  let bv = 0;
  for (let i = from; i < to; i++) {
    const v = Math.abs(y[i]);
    if (v > bv) {
      bv = v;
      best = i;
    }
  }
  return best;
}

/** 确定性伪随机(可复现) */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}: ${detail}`);
  if (!ok) failures++;
}

// ---------- L0 数值健康 ----------
console.log('L0 数值健康');
{
  // 极限参数 + 满幅噪声
  const c = makeCore(1500, 90, 100);
  const rand = mulberry32(12345);
  let nan = 0;
  let maxAbs = 0;
  for (let i = 0; i < FS * 3; i++) {
    const x = rand() * 2 - 1;
    c.process(x, x);
    if (!Number.isFinite(c.outL) || !Number.isFinite(c.outR)) nan++;
    maxAbs = Math.max(maxAbs, Math.abs(c.outL), Math.abs(c.outR));
  }
  check('无 NaN', nan === 0, `nan=${nan}`);
  check('输出有界(理论上限 1+1/(1-0.9)=11)', maxAbs < 20, `maxAbs=${maxAbs.toFixed(2)}`);

  // 静音→静音
  const c2 = makeCore(400, 40, 30);
  let silentMax = 0;
  for (let i = 0; i < FS; i++) {
    c2.process(0, 0);
    silentMax = Math.max(silentMax, Math.abs(c2.outL), Math.abs(c2.outR));
  }
  check('静音→静音', silentMax === 0, `silentMax=${silentMax.toExponential(1)}`);

  // 参数全程扫掠(time/fb/mix 每 0.25s 全行程跳变)
  const c3 = makeCore(400, 40, 30);
  const rand2 = mulberry32(999);
  let nan3 = 0;
  let maxAbs3 = 0;
  for (let i = 0; i < FS * 6; i++) {
    if (i % Math.round(FS / 4) === 0) {
      const step = i / Math.round(FS / 4);
      c3.setTimeMs(50 + ((step * 97) % 1451)); // 50~1500
      c3.setFeedback(((step * 53) % 91) / 100); // 0~0.90
      c3.setMix(((step * 29) % 101) / 100); // 0~1
    }
    const x = rand2() * 2 - 1;
    c3.process(x, x);
    if (!Number.isFinite(c3.outL) || !Number.isFinite(c3.outR)) nan3++;
    maxAbs3 = Math.max(maxAbs3, Math.abs(c3.outL), Math.abs(c3.outR));
  }
  check('参数全程扫掠无 NaN', nan3 === 0, `nan=${nan3}`);
  check('参数全程扫掠有界', maxAbs3 < 20, `maxAbs=${maxAbs3.toFixed(2)}`);
}

// ---------- L1 特征指标 ----------
console.log('L1 特征指标');
{
  // 1) 延迟时间准确(±2%):首回声(L)在 1·TIME,次回声(R)在 2·TIME
  for (const timeMs of [50, 400, 1500]) {
    const D = Math.round((timeMs / 1000) * FS);
    const c = makeCore(timeMs, 40, 100);
    settle(c, 0.5);
    const P = 64;
    const rec = P + 2 * D + Math.round(0.02 * FS);
    const inL = new Float64Array(rec);
    const inR = new Float64Array(rec);
    inL[P] = 1;
    inR[P] = 1;
    const { l, r } = runStereo(c, inL, inR);
    const w = Math.round(0.1 * D);
    const t1 = argmaxAbs(l, P + D - w, P + D + w);
    const err1 = Math.abs(t1 - (P + D)) / D;
    const t2 = argmaxAbs(r, P + 2 * D - w, P + 2 * D + w);
    const err2 = Math.abs(t2 - (P + 2 * D)) / (2 * D);
    check(
      `TIME=${timeMs}ms 首回声位置误差 ≤2%`,
      err1 <= 0.02,
      `实测 ${t1 - P}/${D} 样本,误差 ${(err1 * 100).toFixed(3)}%`,
    );
    check(
      `TIME=${timeMs}ms 次回声位置误差 ≤2%`,
      err2 <= 0.02,
      `实测 ${t2 - P}/${2 * D} 样本,误差 ${(err2 * 100).toFixed(3)}%`,
    );
  }

  // 2) 严格 L/R 交替:第 k 次回声(k=1..6)只在预期声道出现,串声道能量 ≈ 0
  {
    const timeMs = 300;
    const D = Math.round((timeMs / 1000) * FS);
    const c = makeCore(timeMs, 70, 100);
    settle(c, 0.5);
    const P = 64;
    const rec = P + 6 * D + Math.round(0.02 * FS);
    const inL = new Float64Array(rec);
    const inR = new Float64Array(rec);
    inL[P] = 1;
    inR[P] = 1;
    const { l, r } = runStereo(c, inL, inR);
    let allOk = true;
    const details: string[] = [];
    for (let k = 1; k <= 6; k++) {
      const from = P + k * D - 96;
      const to = P + k * D + 960;
      const eL = energy(l, from, to);
      const eR = energy(r, from, to);
      const expectL = k % 2 === 1;
      const eRight = expectL ? eL : eR;
      const eWrong = expectL ? eR : eL;
      const ok = eRight > 1e-9 && eWrong <= 1e-6 * eRight;
      if (!ok) allOk = false;
      details.push(`k${k}:${expectL ? 'L' : 'R'} 串扰比=${(eWrong / eRight).toExponential(1)}`);
    }
    check('回声 1~6 严格 L/R 交替(串扰 ≤1e-6)', allOk, details.join(' '));
  }

  // 3) 反馈衰减平滑:500Hz  bursts,回声幅度按 fb 几何衰减且各次比率一致
  {
    const timeMs = 250;
    const D = Math.round((timeMs / 1000) * FS);
    const fb = 0.7;
    const burst = hannBurst(500, 8, 0.8);
    const c = makeCore(timeMs, fb * 100, 100);
    settle(c, 0.5);
    const P = 64;
    const rec = P + 5 * D + burst.length + 1024;
    const inL = new Float64Array(rec);
    const inR = new Float64Array(rec);
    inL.set(burst, P);
    inR.set(burst, P);
    const { l, r } = runStereo(c, inL, inR);
    const amps: number[] = [];
    for (let k = 1; k <= 4; k++) {
      const from = P + k * D - 96;
      const to = P + k * D + burst.length + 480;
      amps.push(rms(k % 2 === 1 ? l : r, from, to));
    }
    const ratios = [amps[1] / amps[0], amps[2] / amps[1], amps[3] / amps[2]];
    const mono = amps.every((a, i) => i === 0 || a < amps[i - 1]);
    const inBand = ratios.every((x) => x >= 0.94 * fb && x <= 1.01 * fb);
    const maxDiff = Math.max(...ratios) - Math.min(...ratios);
    check('回声幅度单调衰减', mono, amps.map((a) => a.toFixed(4)).join(' → '));
    check(
      '各次衰减比 ≈ fb±5%(反馈低通@500Hz 额外衰减 ≤1%)',
      inBand,
      ratios.map((x) => x.toFixed(3)).join(' '),
    );
    check('衰减比一致(平滑,极差 ≤0.01)', maxDiff <= 0.01, `极差=${maxDiff.toFixed(4)}`);

    // fb=0 → 严格单次回声
    const c0 = makeCore(timeMs, 0, 100);
    settle(c0, 0.5);
    const inL0 = new Float64Array(rec);
    const inR0 = new Float64Array(rec);
    inL0.set(burst, P);
    inR0.set(burst, P);
    const o0 = runStereo(c0, inL0, inR0);
    const e1 = energy(o0.l, P + D - 96, P + D + burst.length + 480);
    const e2 = energy(o0.r, P + 2 * D - 96, P + 2 * D + burst.length + 480) + energy(o0.l, P + 2 * D - 96, P + 2 * D + burst.length + 480);
    check('FEEDBACK=0 时仅一次回声', e2 <= 1e-6 * e1 && e1 > 1e-6, `e2/e1=${(e2 / e1).toExponential(1)}`);
  }

  // 4) 单声道输入首回声只在 L 侧(双声道同信号 / 仅 L 有信号两种单声道形态)
  {
    const timeMs = 200;
    const D = Math.round((timeMs / 1000) * FS);
    const burst = hannBurst(500, 8, 0.8);
    for (const variant of ['双声道同信号', '仅 L 有信号'] as const) {
      const c = makeCore(timeMs, 40, 100);
      settle(c, 0.5);
      const P = 64;
      const rec = P + D + burst.length + 1024;
      const inL = new Float64Array(rec);
      const inR = new Float64Array(rec);
      inL.set(burst, P);
      if (variant === '双声道同信号') inR.set(burst, P);
      const { l, r } = runStereo(c, inL, inR);
      const from = P + D - 96;
      const to = P + D + burst.length + 480;
      const eL = energy(l, from, to);
      const eR = energy(r, from, to);
      check(
        `单声道输入(${variant})首回声仅在 L 侧`,
        eL > 1e-8 && eR <= 1e-6 * eL,
        `R/L=${(eR / eL).toExponential(1)}`,
      );
    }
  }
}

// ---------- L2 行为特征 ----------
console.log('L2 行为特征');
{
  // 1) 反馈低通渐暗:5kHz 回声衰减远快于 400Hz(每反弹一次多过一次 3.5kHz 一阶 LP)
  const timeMs = 200;
  const D = Math.round((timeMs / 1000) * FS);
  const fb = 0.7;
  const echoRatio = (freq: number, ms: number): number => {
    const burst = hannBurst(freq, ms, 0.8);
    const c = makeCore(timeMs, fb * 100, 100);
    settle(c, 0.5);
    const P = 64;
    const rec = P + 3 * D + burst.length + 1024;
    const inL = new Float64Array(rec);
    const inR = new Float64Array(rec);
    inL.set(burst, P);
    inR.set(burst, P);
    const { l } = runStereo(c, inL, inR); // 1、3 次回声都在 L
    const a1 = rms(l, P + D - 96, P + D + burst.length + 480);
    const a3 = rms(l, P + 3 * D - 96, P + 3 * D + burst.length + 480);
    return a3 / a1;
  };
  const ratioLF = echoRatio(400, 8);
  const ratioHF = echoRatio(5000, 4);
  check(
    '低频回声遵守 fb² 定律(3次/1次 ≈ 0.49)',
    ratioLF >= 0.9 * fb * fb && ratioLF <= 1.02 * fb * fb,
    `400Hz 比=${ratioLF.toFixed(3)}`,
  );
  check(
    '高频重复显著变暗(HF 衰减比 < 0.5×LF)',
    ratioHF < 0.5 * ratioLF,
    `5000Hz 比=${ratioHF.toFixed(3)} vs 400Hz 比=${ratioLF.toFixed(3)}(fc=${PINGPONG_LP_FC}Hz)`,
  );

  // 2) MIX 干湿比:干路恒 1,湿路 = mix
  {
    const burst = hannBurst(500, 8, 0.8);
    const c = makeCore(timeMs, 0, 50); // fb=0 隔离单次回声
    settle(c, 0.5);
    const P = 64;
    const rec = P + D + burst.length + 1024;
    const inL = new Float64Array(rec);
    const inR = new Float64Array(rec);
    inL.set(burst, P);
    inR.set(burst, P);
    const { l } = runStereo(c, inL, inR);
    const dry = rms(l, P - 32, P + burst.length + 32);
    const wet = rms(l, P + D - 32, P + D + burst.length + 32);
    const ratio = wet / dry;
    check('MIX=50 时湿/干 = 0.5(±5%)', Math.abs(ratio - 0.5) <= 0.025, `实测 ${ratio.toFixed(3)}`);

    const cM0 = makeCore(timeMs, 0, 0);
    settle(cM0, 0.5);
    const o0 = runStereo(cM0, inL, inR);
    const wet0 = energy(o0.l, P + D - 32, P + D + burst.length + 32);
    check('MIX=0 时无湿声', wet0 <= 1e-12 * energy(o0.l, P - 32, P + burst.length + 32), `wet=${wet0.toExponential(1)}`);
  }

  // 3) TIME 变更即时生效
  {
    const c = makeCore(500, 30, 100);
    settle(c, 0.5);
    const P = 64;
    const D1 = Math.round(0.5 * FS);
    const rec1 = P + D1 + 2048;
    const inL1 = new Float64Array(rec1);
    const inR1 = new Float64Array(rec1);
    inL1[P] = 1;
    inR1[P] = 1;
    const o1 = runStereo(c, inL1, inR1);
    const t1 = argmaxAbs(o1.l, P + D1 - Math.round(0.1 * D1), P + D1 + Math.round(0.1 * D1));
    const err1 = Math.abs(t1 - (P + D1)) / D1;

    c.setTimeMs(150);
    settle(c, 1.5); // 冲掉旧延迟内容(0.3^10 ≈ 6e-6)
    const D2 = Math.round(0.15 * FS);
    const rec2 = P + D1 + 2048;
    const inL2 = new Float64Array(rec2);
    const inR2 = new Float64Array(rec2);
    inL2[P] = 1;
    inR2[P] = 1;
    const o2 = runStereo(c, inL2, inR2);
    const t2 = argmaxAbs(o2.l, P + D2 - Math.round(0.1 * D2), P + D2 + Math.round(0.1 * D2));
    const err2 = Math.abs(t2 - (P + D2)) / D2;
    const eNew = energy(o2.l, P + D2 - 96, P + D2 + 960);
    const eOld = energy(o2.l, P + D1 - 96, P + D1 + 960);
    check('TIME=500ms 回声位置正确', err1 <= 0.02, `误差 ${(err1 * 100).toFixed(3)}%`);
    check('改为 150ms 后回声位置正确', err2 <= 0.02, `误差 ${(err2 * 100).toFixed(3)}%`);
    check('旧 TIME 位置无残留(<1%)', eOld <= 0.01 * eNew, `eOld/eNew=${(eOld / eNew).toExponential(1)}`);
  }
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项未过 ✗`);
if (failures > 0) process.exit(1);
