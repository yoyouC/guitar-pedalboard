/**
 * BBD 模拟延迟(模拟延迟 ⚗)正确性评测(L0~L2)
 * Node 直跑:node scripts/wdf-analogdelay-eval.ts
 *
 * 特征基准:Boss DM-2 / Memory Man 风格 BBD 延迟——
 * 每次重复多过一对低通极点(逐级变暗)、轻微本底噪声、慢速调制(重复音 vibrato)。
 * 全部为时域测量(峰值/包络/能量比),不涉及 DFT 泄漏问题。
 */
import { BbdAnalogDelay } from '../src/audio/wdf/analogDelay.dsp.js';

const BASE = 48000;

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}: ${detail}`);
  if (!ok) failures++;
}

/** 构造并按 ≥0.5s 建立期静置(§4.2:TIME 摆率/滤波器状态全部到位) */
function makeDelay(p: { time?: number; feedback?: number; tone?: number; mod?: number; mix?: number }): BbdAnalogDelay {
  const d = new BbdAnalogDelay(BASE);
  if (p.time !== undefined) d.setTime(p.time);
  if (p.feedback !== undefined) d.setFeedback(p.feedback);
  if (p.tone !== undefined) d.setTone(p.tone);
  if (p.mod !== undefined) d.setMod(p.mod);
  if (p.mix !== undefined) d.setMix(p.mix);
  for (let i = 0; i < BASE / 2; i++) d.process(0);
  return d;
}

/** 单位冲激响应(建立期后打 1.0 单样本冲激) */
function impulse(d: BbdAnalogDelay, n: number): Float64Array {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = d.process(i === 0 ? 1 : 0);
  return y;
}

/** 离线一阶低通(测量用,与 DSP 内同一系数形式) */
function lp1(y: Float64Array, fc: number): Float64Array {
  const a = 1 / (BASE / (2 * Math.PI * fc) + 1);
  const out = new Float64Array(y.length);
  let s = 0;
  for (let i = 0; i < y.length; i++) {
    s += a * (y[i] - s);
    out[i] = s;
  }
  return out;
}

/** 窗口内 |x| 最大值位置 */
function argmaxAbs(y: Float64Array, lo: number, hi: number): number {
  let best = -1;
  let bv = -1;
  for (let i = Math.max(0, lo); i < Math.min(y.length, hi); i++) {
    const v = Math.abs(y[i]);
    if (v > bv) {
      bv = v;
      best = i;
    }
  }
  return best;
}

/** 窗口内 |x| 最大值 */
function maxAbs(y: Float64Array, lo: number, hi: number): number {
  return Math.abs(y[argmaxAbs(y, lo, hi)]);
}

// ---------- L0 健康 ----------
console.log('L0 健康');
{
  // 压力:高反馈 + 调制 + 全湿,1kHz 0.5 正弦 2s
  const d = makeDelay({ time: 300, feedback: 90, tone: 50, mod: 60, mix: 100 });
  let nan = 0;
  let maxA = 0;
  for (let i = 0; i < BASE * 2; i++) {
    const out = d.process(0.5 * Math.sin((2 * Math.PI * 1000 * i) / BASE));
    if (!Number.isFinite(out)) nan++;
    maxA = Math.max(maxA, Math.abs(out));
  }
  check('无 NaN', nan === 0, `nan=${nan}`);
  check('输出有界(fb=90% 全湿 < 5)', maxA < 5, `maxAbs=${maxA.toFixed(2)}`);

  // 静音:仅本底噪声,无自激增长(fb=95% 最恶劣,8s)
  const d2 = makeDelay({ time: 100, feedback: 95, tone: 100, mix: 100 });
  let s1 = 0;
  let s2 = 0;
  let maxSilent = 0;
  for (let i = 0; i < BASE * 8; i++) {
    const out = d2.process(0);
    maxSilent = Math.max(maxSilent, Math.abs(out));
    if (i >= BASE * 3 && i < BASE * 4) s1 += out * out;
    if (i >= BASE * 7) s2 += out * out;
  }
  const rms1 = Math.sqrt(s1 / BASE);
  const rms2 = Math.sqrt(s2 / BASE);
  check('静音→仅本底噪声(< -46dBFS)', maxSilent < 5e-3, `maxAbs=${maxSilent.toExponential(2)}`);
  check('噪声无增长(无自激/极限环)', rms2 < 1.2 * rms1, `rms ${rms1.toExponential(2)} → ${rms2.toExponential(2)} (×${(rms2 / rms1).toFixed(2)})`);

  // 参数全程扫掠
  const d3 = makeDelay({});
  let nan3 = 0;
  let maxA3 = 0;
  const seg = Math.floor(BASE * 0.6);
  let start = 0;
  const run = (fn: (t: number) => void) => {
    for (let i = 0; i < seg; i++) {
      fn(i / seg);
      const out = d3.process(0.3 * Math.sin((2 * Math.PI * 1000 * (start + i)) / BASE));
      if (!Number.isFinite(out)) nan3++;
      maxA3 = Math.max(maxA3, Math.abs(out));
    }
    start += seg;
  };
  run((t) => d3.setTime(20 + t * 580));
  run((t) => d3.setTime(600 - t * 580));
  run((t) => d3.setFeedback(t * 95));
  run((t) => d3.setFeedback(95 - t * 95));
  run((t) => d3.setTone(t * 100));
  run((t) => d3.setMod(t * 100));
  run((t) => d3.setMix(t * 100));
  check('参数全程扫掠无 NaN', nan3 === 0, `nan=${nan3}`);
  check('参数全程扫掠有界(< 10)', maxA3 < 10, `maxAbs=${maxA3.toFixed(2)}`);
}

// ---------- L1 特征指标 ----------
console.log('L1 特征指标');
{
  // 1) 延迟时间准确(±2%),含分数样本 123.4ms
  const times = [20, 50, 123.4, 300, 600];
  let worst = 0;
  let worstT = 0;
  for (const ms of times) {
    const d = makeDelay({ time: ms, feedback: 50, mix: 100, mod: 0 });
    const D = (ms * BASE) / 1000;
    const y = impulse(d, Math.ceil(D * 2.2));
    const p = argmaxAbs(y, Math.floor(D * 0.85), Math.ceil(D * 1.15));
    const err = Math.abs(p - D) / D;
    if (err > worst) {
      worst = err;
      worstT = ms;
    }
  }
  check('延迟时间准确(±2%)', worst <= 0.02, `worst=${(worst * 100).toFixed(3)}% @ ${worstT}ms`);

  // 回声间隔(第 2 次回声扣掉滤波器群延迟后仍 ≈ D)
  const d = makeDelay({ time: 300, feedback: 60, mix: 100, mod: 0 });
  const D = (300 * BASE) / 1000;
  const y = impulse(d, Math.ceil(D * 2.6));
  const p1 = argmaxAbs(y, Math.floor(D * 0.9), Math.ceil(D * 1.1));
  const p2 = argmaxAbs(y, Math.floor(D * 1.9), Math.ceil(D * 2.1));
  const spErr = Math.abs(p2 - p1 - D) / D;
  check('回声间隔准确(±2%)', spErr <= 0.02, `err=${(spErr * 100).toFixed(3)}% (Δ=${p2 - p1} vs ${D})`);
}
{
  // 2) 逐级变暗:回声 1/2/3 的 >2kHz 高频能量比
  const darkAt = (tone: number): number[] => {
    const d = makeDelay({ time: 150, feedback: 80, tone, mix: 100 });
    const D = (150 * BASE) / 1000;
    const y = impulse(d, Math.ceil(D * 3.4));
    const lp = lp1(y, 2000);
    const rs: number[] = [];
    for (let k = 1; k <= 3; k++) {
      const pk = argmaxAbs(y, Math.floor(k * D - 0.1 * D), Math.ceil(k * D + 0.1 * D));
      let ehp = 0;
      let etot = 0;
      for (let i = pk - 48; i < pk + 240; i++) {
        const h = y[i] - lp[i];
        ehp += h * h;
        etot += y[i] * y[i];
      }
      rs.push(ehp / etot);
    }
    return rs;
  };
  const r = darkAt(50);
  check(
    '回声 1→2→3 高频含量递减',
    r[0] > r[1] && r[1] > r[2],
    `r1=${r[0].toFixed(3)} r2=${r[1].toFixed(3)} r3=${r[2].toFixed(3)}`,
  );
  check(
    '每级高频衰减 ≥25%',
    r[1] <= 0.75 * r[0] && r[2] <= 0.75 * r[1],
    `r2/r1=${(r[1] / r[0]).toFixed(2)} r3/r2=${(r[2] / r[1]).toFixed(2)}`,
  );
  const dropDark = darkAt(15);
  const dropBright = darkAt(85);
  const ratio = (rr: number[]) => rr[1] / rr[0];
  check(
    'TONE 控制重复暗度',
    ratio(dropDark) <= 0.7 * ratio(dropBright),
    `tone15 r2/r1=${ratio(dropDark).toFixed(2)} vs tone85=${ratio(dropBright).toFixed(2)}`,
  );
}
{
  // 3) 反馈:每循环增益 ≈ FEEDBACK(tone=100 排除 LP 影响,400Hz 低频包络)
  const echoAmps = (fbPct: number): number[] => {
    const d = makeDelay({ time: 100, feedback: fbPct, tone: 100, mix: 100 });
    const D = (100 * BASE) / 1000;
    const y = impulse(d, Math.ceil(D * 32));
    const env = lp1(y, 400);
    const amps: number[] = [];
    for (let k = 1; k <= 30; k++) {
      amps.push(maxAbs(env, Math.round(k * D - 0.25 * D), Math.round(k * D + 0.25 * D)));
    }
    return amps;
  };
  const gainOf = (amps: number[]): number => {
    let g = 1;
    for (let k = 0; k < 5; k++) g *= amps[k + 1] / amps[k];
    return Math.pow(g, 1 / 5);
  };
  const g60 = gainOf(echoAmps(60));
  const g85 = gainOf(echoAmps(85));
  // 判据:测得每循环增益 / 设定反馈 ∈ [0.94, 1.01]
  //(恒有 -3.2% 残留:tone=100 双极点 LP + 测量链频谱加权,实测两档同为 ×0.968)
  const ratioOf = (g: number, fb: number) => g / (fb / 100);
  check(
    '每循环增益 ≈ FEEDBACK=60%(比值 0.94~1.01)',
    ratioOf(g60, 60) >= 0.94 && ratioOf(g60, 60) <= 1.01,
    `g=${g60.toFixed(3)} (×${ratioOf(g60, 60).toFixed(3)})`,
  );
  check(
    '每循环增益 ≈ FEEDBACK=85%(比值 0.94~1.01)',
    ratioOf(g85, 85) >= 0.94 && ratioOf(g85, 85) <= 1.01,
    `g=${g85.toFixed(3)} (×${ratioOf(g85, 85).toFixed(3)})`,
  );

  // 反馈次数可控:包络 > 回声1 的 1%(-40dB)的回声数
  const counts = [20, 50, 80].map((fb) => {
    const amps = echoAmps(fb);
    const thr = 0.01 * amps[0];
    const count = amps.filter((a) => a > thr).length;
    const gIdeal = 0.9968 * (fb / 100); // tone=100 时 LP 在 400Hz 的每循环残留
    const expected = Math.floor(Math.log(0.01) / Math.log(gIdeal)) + 1;
    return { fb, count, expected };
  });
  for (const c of counts) {
    const tol = Math.max(1, Math.ceil(c.expected * 0.15));
    check(
      `FEEDBACK=${c.fb}% 重复次数 ≈ 理论`,
      Math.abs(c.count - c.expected) <= tol,
      `测得 ${c.count} 次,理论 ${c.expected} 次(±${tol})`,
    );
  }
  check(
    '重复次数随 FEEDBACK 单调增加',
    counts[0].count < counts[1].count && counts[1].count < counts[2].count,
    counts.map((c) => `fb${c.fb}:${c.count}`).join(' '),
  );
}

// ---------- L2 行为特征 ----------
console.log('L2 行为特征');
{
  // 1) MOD:回声位置随 LFO 摆动(仅湿声 vibrato),深度随 MOD 加倍
  const spreadAt = (modPct: number): number => {
    const d = makeDelay({ time: 50, feedback: 0, mix: 100, mod: modPct });
    const D = (50 * BASE) / 1000; // 2400
    const spacing = (150 * BASE) / 1000; // 7200
    const total = BASE * 3;
    const y = new Float64Array(total);
    for (let i = 0; i < total; i++) y[i] = d.process(i % spacing === 0 ? 1 : 0);
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 5; k * spacing + D + 600 < total; k++) {
      const p = argmaxAbs(y, Math.round(k * spacing + D - 600), Math.round(k * spacing + D + 600));
      const rel = p - k * spacing;
      lo = Math.min(lo, rel);
      hi = Math.max(hi, rel);
    }
    return ((hi - lo) / BASE) * 1000; // ms 峰峰摆幅
  };
  const s0 = spreadAt(0);
  const s50 = spreadAt(50);
  const s100 = spreadAt(100);
  check('MOD=0 回声位置稳定(< 0.1ms)', s0 <= 0.1, `摆幅=${s0.toFixed(3)}ms`);
  check('MOD=50 摆幅 ≈ 2.5ms(1.4~3.2)', s50 >= 1.4 && s50 <= 3.2, `摆幅=${s50.toFixed(2)}ms`);
  check('MOD=100 摆幅 ≈ 5ms(3.0~6.0)', s100 >= 3.0 && s100 <= 6.0, `摆幅=${s100.toFixed(2)}ms`);
  check('调制深度随 MOD 缩放(×1.3~2.6)', s100 / s50 >= 1.3 && s100 / s50 <= 2.6, `s100/s50=${(s100 / s50).toFixed(2)}`);
}
{
  // 2) MIX:干湿比例
  const wetRatio = (mixPct: number): number => {
    const d = makeDelay({ time: 100, feedback: 0, mix: mixPct });
    const D = (100 * BASE) / 1000;
    const y = impulse(d, Math.ceil(D * 1.5));
    return maxAbs(y, Math.floor(D * 0.9), Math.ceil(D * 1.1)) / Math.abs(y[0]);
  };
  const m0 = wetRatio(0);
  const m50 = wetRatio(50);
  const m100 = wetRatio(100);
  check('MIX=0 → 无湿声', m0 < 1e-9, `wet/dry=${m0.toExponential(2)}`);
  check('MIX 线性(50/100 ≈ 0.5)', m50 / m100 >= 0.45 && m50 / m100 <= 0.55, `m50/m100=${(m50 / m100).toFixed(3)}`);
}
{
  // 3) BBD 本底噪声:存在但轻微
  const d = makeDelay({ feedback: 0, mix: 100 });
  let sum = 0;
  for (let i = 0; i < BASE; i++) {
    const out = d.process(0);
    sum += out * out;
  }
  const nRms = Math.sqrt(sum / BASE);
  check(
    '湿路本底噪声存在且轻微(-94~-74dBFS)',
    nRms > 2e-5 && nRms < 2e-4,
    `rms=${nRms.toExponential(2)} (${(20 * Math.log10(nRms)).toFixed(1)}dBFS)`,
  );
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项未过 ✗`);
if (failures > 0) process.exit(1);
