/**
 * Dyna Comp 风格 OTA 压缩正确性评测(L0~L2,Node 直跑:node scripts/wdf-dynacomp-eval.ts)
 * 对照基准:MXR Dyna Comp 特征 —— 重压缩(~10:1+)、固定快启动(<10ms)、
 * 中速释放(200~500ms)、SENSITIVITY 宽阈值行程、LEVEL 输出补偿(dB 域)。
 *
 * 结构说明:压缩是线性时变系统(VCA + 反馈包络环),无削波非线性,
 * 故按 docs/wdf-whitebox-process.md 对时序类的约定不过采样,直接 48kHz。
 * 静态测量一律 ≥0.5s 建立期(本脚本稳态用 1.25s ≈ 5·τ_rel),DFT 窗取整数周期。
 */
import { DynaCompCore } from '../src/audio/wdf/dynaComp.ts';
import { levelDbToGain } from '../src/audio/level.ts';

const FS = 48000;

/** 与 worklet 同构的完整链:压缩核心 → LEVEL(线性增益) */
function makeChain(sens: number, levelDb = 0) {
  const core = new DynaCompCore({ fs: FS });
  core.setSensitivity(sens);
  const levelGain = levelDbToGain(levelDb);
  return {
    core,
    process(x: number): number {
      return core.process(x) * levelGain;
    },
  };
}

function db(lin: number): number {
  return 20 * Math.log10(lin);
}

function rmsDb(y: Float64Array, i0: number, i1: number): number {
  let s = 0;
  for (let i = i0; i < i1; i++) s += y[i] * y[i];
  return db(Math.sqrt(s / (i1 - i0)));
}

/** 1kHz @48k:48 样本/周期;测量窗 4800 = 100 整周期(DFT 无泄漏) */
const WIN = 4800;

/** 稳态测量:建立期 1.25s(5·τ_rel)后采集 100 整周期,返回输入/输出 RMS(dB) */
function steadyState(sens: number, amp: number, freq = 1000, levelDb = 0) {
  const chain = makeChain(sens, levelDb);
  const settle = Math.floor(FS * 1.25);
  for (let i = 0; i < settle; i++) {
    chain.process(amp * Math.sin((2 * Math.PI * freq * i) / FS));
  }
  const x = new Float64Array(WIN);
  const y = new Float64Array(WIN);
  for (let i = 0; i < WIN; i++) {
    x[i] = amp * Math.sin((2 * Math.PI * freq * (settle + i)) / FS);
    y[i] = chain.process(x[i]);
  }
  return { inDb: rmsDb(x, 0, WIN), outDb: rmsDb(y, 0, WIN) };
}

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}: ${detail}`);
  if (!ok) failures++;
}

// ---------- L0 求解器健康 ----------
console.log('L0 求解器健康');
{
  // 多输入电平 × 多灵敏度,无 NaN、有界
  let nan = 0, maxAbs = 0;
  for (const amp of [1e-4, 0.01, 0.1, 0.5, 2.0]) {
    for (const sens of [0, 0.25, 0.5, 0.75, 1]) {
      const chain = makeChain(sens);
      for (let i = 0; i < FS / 5; i++) {
        const out = chain.process(amp * Math.sin((2 * Math.PI * 1000 * i) / FS));
        if (!Number.isFinite(out)) nan++;
        maxAbs = Math.max(maxAbs, Math.abs(out));
      }
    }
  }
  check('无 NaN(5 电平 × 5 灵敏度)', nan === 0, `nan=${nan}`);
  check('输出有界(增益只压不增)', maxAbs < 2.1, `maxAbs=${maxAbs.toFixed(3)}`);

  // 静音 → 静音(增益回 1,无极限环)
  const c = makeChain(0.8);
  let silentMax = 0;
  for (let i = 0; i < FS / 2; i++) silentMax = Math.max(silentMax, Math.abs(c.process(0)));
  check('静音→静音', silentMax < 1e-12, `silentMax=${silentMax.toExponential(1)} grDb=${c.core.grDb.toExponential(1)}`);

  // 参数全程扫掠稳定:SENSITIVITY 0→100→0、LEVEL −30→+6dB 同时扫
  const sweep = makeChain(0.5);
  let sweepNan = 0, sweepMax = 0;
  const N = FS;
  for (let i = 0; i < N; i++) {
    const ph = (Math.PI * i) / N; // 0→π→cos 1→-1→1 往返
    sweep.core.setSensitivity(0.5 - 0.5 * Math.cos(2 * ph));
    const levelDb = -30 + 36 * (i / N);
    const g = levelDbToGain(levelDb);
    const out = sweep.core.process(0.2 * Math.sin((2 * Math.PI * 1000 * i) / FS)) * g;
    if (!Number.isFinite(out)) sweepNan++;
    sweepMax = Math.max(sweepMax, Math.abs(out));
  }
  check('参数全程扫掠无 NaN', sweepNan === 0, `nan=${sweepNan}`);
  check('参数扫掠有界(<0.5)', sweepMax < 0.5, `maxAbs=${sweepMax.toFixed(3)}`);
}

// ---------- L1 静态压缩特性 ----------
console.log('L1 静态压缩特性(稳态,整数周期窗)');
{
  // 压缩比:两点法(Δin/Δout),两对电平均远在阈值之上(sens=50 → thr=−32.5dB)
  const pair = (ampHi: number, ampLo: number) => {
    const hi = steadyState(0.5, ampHi);
    const lo = steadyState(0.5, ampLo);
    return (hi.inDb - lo.inDb) / (hi.outDb - lo.outDb);
  };
  const r1 = pair(0.316, 0.1);   // ≈ −10 / −20 dBFS
  const r2 = pair(0.1, 0.05);    // ≈ −20 / −26 dBFS
  check('重压缩比 >8:1(−10/−20dBFS)', r1 > 8, `ratio=${r1.toFixed(1)}:1`);
  check('重压缩比 >8:1(−20/−26dBFS)', r2 > 8, `ratio=${r2.toFixed(1)}:1`);

  // 阈值行程:sens 0/50/100 的压缩起始点(GR≥2dB 的最低输入电平)
  const onset = (sens: number): number => {
    for (let inDb = -70; inDb <= -4; inDb += 3) {
      const amp = Math.pow(10, inDb / 20);
      const { inDb: mIn, outDb } = steadyState(sens, amp, 1000, 0);
      if (mIn - outDb >= 2) return mIn;
    }
    return Infinity;
  };
  const o0 = onset(0), o50 = onset(0.5), o100 = onset(1);
  check('起始点单调(灵敏度↑ → 阈值↓)', o0 > o50 && o50 > o100,
    `onset: s0=${o0.toFixed(1)}dB s50=${o50.toFixed(1)}dB s100=${o100.toFixed(1)}dB`);
  check('低灵敏度只压响信号(onset s0 ∈ [−20,−5]dB)', o0 >= -20 && o0 <= -5, `o0=${o0.toFixed(1)}dB`);
  check('高灵敏度压弱信号(onset s100 ∈ [−70,−48]dB)', o100 >= -70 && o100 <= -48, `o100=${o100.toFixed(1)}dB`);
  check('灵敏度量程覆盖宽输入(≥30dB)', o0 - o100 >= 30, `span=${(o0 - o100).toFixed(1)}dB`);

  // 高灵敏度下 −40dBFS 弱信号也被显著压缩
  const quiet = steadyState(1, Math.pow(10, -40 / 20));
  check('s100 压 −40dBFS 弱信号(GR≥6dB)', quiet.inDb - quiet.outDb >= 6,
    `GR=${(quiet.inDb - quiet.outDb).toFixed(1)}dB`);
  // 低灵敏度下 −30dBFS 中等信号基本不压
  const mild = steadyState(0, Math.pow(10, -30 / 20));
  check('s0 不压 −30dBFS 中等信号(GR<1dB)', mild.inDb - mild.outDb < 1,
    `GR=${(mild.inDb - mild.outDb).toFixed(2)}dB`);
}

// ---------- L2 动态行为 ----------
console.log('L2 动态行为(突发/释放/延音/补偿)');
{
  // 启动:静音 → −10dBFS 1kHz 突发,记录 GR(t) 与输出包络
  const chain = makeChain(0.5);
  for (let i = 0; i < FS / 10; i++) chain.process(0); // 0.1s 静音建立
  const burstN = Math.floor(FS * 0.5);
  const amp = 0.316;
  const y = new Float64Array(burstN);
  const gr = new Float64Array(burstN);
  for (let i = 0; i < burstN; i++) {
    y[i] = chain.process(amp * Math.sin((2 * Math.PI * 1000 * i) / FS));
    gr[i] = chain.core.grDb;
  }
  const ssFrom = burstN - Math.floor(FS * 0.02);
  let grSS = 0;
  for (let i = ssFrom; i < burstN; i++) grSS += gr[i];
  grSS /= burstN - ssFrom;

  // t90:前 50ms 内最后一次低于 90% 稳态 GR 的时刻(抗纹波)
  const win90 = Math.floor(FS * 0.05);
  let t90 = 0;
  for (let i = 0; i < win90; i++) if (gr[i] < 0.9 * grSS) t90 = i;
  const t90ms = (t90 / FS) * 1000;
  check('快速固定启动(t90 < 10ms)', t90ms < 10, `t90=${t90ms.toFixed(2)}ms (GRss=${grSS.toFixed(1)}dB)`);

  // 泵感起音:前 8ms 输出峰值超出稳态峰值的 dB 数(启动滞后 → 瞬态冲出再压下)
  let peakEarly = 0, peakSS = 0;
  for (let i = 0; i < Math.floor(FS * 0.008); i++) peakEarly = Math.max(peakEarly, Math.abs(y[i]));
  for (let i = ssFrom; i < burstN; i++) peakSS = Math.max(peakSS, Math.abs(y[i]));
  const overshootDb = db(peakEarly) - db(peakSS);
  check('标志性泵感过冲(≥3dB)', overshootDb >= 3, `overshoot=${overshootDb.toFixed(1)}dB`);

  // 释放:突发结束后 GR 从稳态指数恢复,t63 = τ_rel
  const relN = Math.floor(FS * 0.8);
  const grRel = new Float64Array(relN);
  for (let i = 0; i < relN; i++) {
    chain.process(0);
    grRel[i] = chain.core.grDb;
  }
  const target63 = grSS / Math.E;
  let t63 = relN - 1;
  for (let i = 0; i < relN; i++) {
    if (grRel[i] <= target63) { t63 = i; break; }
  }
  const t63ms = (t63 / FS) * 1000;
  check('释放中等(t63 ∈ [200,500]ms)', t63ms >= 200 && t63ms <= 500, `t63=${t63ms.toFixed(0)}ms`);

  // 延音:指数衰减音符,压缩后输出衰减显著慢于输入(释放环托住电平)
  const sus = makeChain(0.75);
  const susN = Math.floor(FS * 0.8);
  const sx = new Float64Array(susN);
  const sy = new Float64Array(susN);
  for (let i = 0; i < susN; i++) {
    sx[i] = 0.5 * Math.exp(-i / (0.12 * FS)) * Math.sin((2 * Math.PI * 1000 * i) / FS);
    sy[i] = sus.process(sx[i]);
  }
  const w1: [number, number] = [Math.floor(FS * 0.05), Math.floor(FS * 0.07)];
  const w2: [number, number] = [Math.floor(FS * 0.4), Math.floor(FS * 0.5)];
  const inDrop = rmsDb(sx, ...w1) - rmsDb(sx, ...w2);
  const outDrop = rmsDb(sy, ...w1) - rmsDb(sy, ...w2);
  check('延音(输出衰减 ≪ 输入衰减)', outDrop <= inDrop - 10,
    `inDrop=${inDrop.toFixed(1)}dB outDrop=${outDrop.toFixed(1)}dB`);

  // LEVEL 输出补偿精度(dB 域,±6dB)
  const lev = (ldb: number) => steadyState(0.5, 0.1, 1000, ldb).outDb;
  const lm = lev(-6), l0 = lev(0), lp = lev(6);
  check('LEVEL +6dB 补偿准确(±0.15dB)', Math.abs(lp - l0 - 6) < 0.15, `Δ=${(lp - l0).toFixed(2)}dB`);
  check('LEVEL −6dB 补偿准确(±0.15dB)', Math.abs(l0 - lm - 6) < 0.15, `Δ=${(l0 - lm).toFixed(2)}dB`);
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项未过 ✗`);
if (failures > 0) process.exit(1);
