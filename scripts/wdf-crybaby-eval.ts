/**
 * Crybaby GCB-95 WDF 正确性评测(L0~L3,Node 直跑:node scripts/wdf-crybaby-eval.ts)
 * 对照基准:
 *   - GEO "The Technology of Wah Pedals" 实测偏置:Q1 集电极 4.14V、Q2 基极 3.64V
 *     (GEO 未注明踏板位置;vB2/vC1≈0.88 对应本模型 w≈0.12 跟位附近)。
 *   - Electrosmash GCB-95:谐振峰 450Hz(跟位)~1.6kHz(顶位),峰增益至 +18dB,
 *     中位 ~750Hz。
 *   - ngspice 同网表 AC 扫频(见 L2 注释):w≤0.9 时峰频轨迹与本模型一致;
 *     w→1 时 Q2 失去偏置截止,响应退化为宽架(电路真实行为,非模型缺陷——
 *     真实踏板机械行程到不了电气端点,GEO "Pot Secrets")。
 * 另含 worklet 装配串(?raw 拼装)与 dsp.js 直驱链的逐样本一致性检查。
 */
import { CrybabyStage } from '../src/audio/wdf/crybabyStage.dsp.js';
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from '../src/audio/wdf/resample.dsp.js';
import { buildProcessorSource } from '../src/audio/workletLoader.ts';
import { extractAssembledProcessor } from '../tests/helpers/wdf-golden.ts';

const BASE = 48000;
const FS = BASE * OS_FACTOR;

/** 与 worklet 同构的完整链(升采样 → 放大级 → 降采样) */
function makeChain(position: number) {
  const stage = new CrybabyStage(FS);
  stage.setPosition(position);
  const fir = makeAntiAliasFIR();
  const up = new Upsampler4x(fir);
  const down = new Decimator4x(fir);
  const osBuf = new Float32Array(OS_FACTOR);
  const osOut = [0, 0, 0, 0];
  return {
    stage,
    process(x: number): number {
      up.process(osBuf, x);
      for (let k = 0; k < OS_FACTOR; k++) osOut[k] = stage.process(osBuf[k]);
      return down.process(osOut[0], osOut[1], osOut[2], osOut[3]);
    },
  };
}

/** OS 速率整周期 Goertzel(N=19200 时 10Hz 整数倍的频率均为整周期) */
function goertzelOS(y: Float64Array, f: number): number {
  const N = y.length;
  const w = (2 * Math.PI * f) / FS;
  let re = 0, im = 0;
  for (let n = 0; n < N; n++) {
    re += y[n] * Math.cos(w * n);
    im -= y[n] * Math.sin(w * n);
  }
  return (2 * Math.hypot(re, im)) / N;
}

/** 直接驱动放大级:0.5s 建立(≥0.5s 规范)后采 N 个 OS 样本 */
function captureStage(position: number, amp: number, freq: number, n: number) {
  const s = new CrybabyStage(FS);
  s.setPosition(position);
  const settle = Math.floor(FS * 0.5);
  for (let i = 0; i < settle; i++) s.process(amp * Math.sin((2 * Math.PI * freq * i) / FS));
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = s.process(amp * Math.sin((2 * Math.PI * freq * (i + settle)) / FS));
  return { y, s };
}

function thdOS(y: Float64Array, fund: number): { thd: number; h2h3: number } {
  const f1 = goertzelOS(y, fund);
  const h = [2, 3, 4, 5].map((k) => goertzelOS(y, fund * k));
  return {
    thd: Math.sqrt(h[0] ** 2 + h[1] ** 2 + h[2] ** 2 + h[3] ** 2) / f1,
    h2h3: h[0] / Math.max(1e-12, h[1]),
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
  // 全行程扫掠:position 慢扫 × 多幅度 × 多频率
  let nan = 0, maxAbs = 0, totalNC = 0, totalIter = 0, totalCnt = 0;
  for (const amp of [0.01, 0.1, 0.5, 1.0]) {
    for (const freq of [100, 1000, 5000]) {
      const s = new CrybabyStage(FS);
      const M = FS / 4;
      for (let i = 0; i < M; i++) {
        s.setPosition(0.5 + 0.5 * Math.sin((2 * Math.PI * i) / M));
        const o = s.process(amp * Math.sin((2 * Math.PI * freq * i) / FS));
        if (!Number.isFinite(o)) nan++;
        maxAbs = Math.max(maxAbs, Math.abs(o));
      }
      totalNC += s.nonConverged;
      totalIter += s.iterTotal;
      totalCnt += s.iterCount;
    }
  }
  check('无 NaN', nan === 0, `nan=${nan}`);
  check('输出有界(电源轨内, <10V)', maxAbs < 10, `maxAbs=${maxAbs.toFixed(2)}`);
  check('Newton 全部收敛(nonConverged=0)', totalNC === 0, `nonConverged=${totalNC}`);
  const avgIter = totalIter / Math.max(1, totalCnt);
  check('Newton 收敛速度(平均 <10 次/样本)', avgIter < 10, `avg=${avgIter.toFixed(2)}`);

  // 静音 → 静音(无极限环):1s 静音建立后测 0.1s
  const s2 = new CrybabyStage(FS);
  for (let i = 0; i < FS; i++) s2.process(0);
  let silentMax = 0;
  for (let i = 0; i < FS / 10; i++) silentMax = Math.max(silentMax, Math.abs(s2.process(0)));
  check('静音→静音(无极限环)', silentMax < 1e-9, `silentMax=${silentMax.toExponential(1)}`);

  // DC 偏置(对照 GEO 实测:Q1 集电极 4.14V、Q2 基极 3.64V,容差 ±0.6V)
  const names = ['vB0', 'vE0', 'vB1', 'vC1', 'vE1', 'vB2', 'vE2', 'vX', 'vY'];
  const biasAt = (w: number) => {
    const s = new CrybabyStage(FS);
    s.setPosition(w);
    for (let i = 0; i < FS / 10; i++) s.process(0);
    return s.nodeVoltages;
  };
  const dcMid = biasAt(0.5);
  console.log(`    偏置@w=0.5: ${dcMid.map((v, i) => `${names[i]}=${v.toFixed(3)}`).join(' ')}`);
  check('DC 偏置 vC1 ≈ GEO 4.14V±0.6(w=0.5)', Math.abs(dcMid[3] - 4.14) < 0.6, `vC1=${dcMid[3].toFixed(3)}`);
  // GEO 实测时踏板应在跟位附近(vB2/vC1≈0.88 → w≈0.12)
  const dcHeel = biasAt(0.12);
  console.log(`    偏置@w=0.12: ${dcHeel.map((v, i) => `${names[i]}=${v.toFixed(3)}`).join(' ')}`);
  check(
    'DC 偏置 vB2 ≈ GEO 3.64V±0.6(w=0.12 跟位附近)',
    Math.abs(dcHeel[5] - 3.64) < 0.6,
    `vB2=${dcHeel[5].toFixed(3)} (vB2/vC1=${(dcHeel[5] / dcHeel[3]).toFixed(2)},GEO=0.88)`,
  );
}

// ---------- L1 传输特性(w=0.5,谐振峰 550Hz 幅度扫描) ----------
console.log('L1 传输特性(w=0.5,550Hz 幅度扫描)');
{
  const peaks = (amp: number) => {
    const { y } = captureStage(0.5, amp, 550, 19200);
    let mp = 0, mn = 0;
    for (const v of y) {
      mp = Math.max(mp, v);
      mn = Math.min(mn, v);
    }
    return { mp, mn };
  };
  const p5m = peaks(0.005);
  const p10m = peaks(0.01);
  const p100m = peaks(0.1);
  const p1 = peaks(1.0);
  check(
    '小信号线性(0.01V/0.005V 峰值比 ≈2,±5%)',
    Math.abs(p10m.mp / p5m.mp - 2) < 0.1,
    `5mV=${p5m.mp.toFixed(4)}V 10mV=${p10m.mp.toFixed(4)}V ratio=${(p10m.mp / p5m.mp).toFixed(3)}`,
  );
  check(
    '大驱动增益压缩(1V 增益 <60% 小信号增益)',
    p1.mp / (10 * p100m.mp) < 0.6 && p1.mp > 1.5,
    `100mV=${p100m.mp.toFixed(2)}V 1V=${p1.mp.toFixed(2)}V(增益 ${(p1.mp / 1).toFixed(2)}x vs 小信号 ${(p100m.mp / 0.1).toFixed(2)}x)`,
  );
  check(
    '软削波有界(峰值 <9V 电源轨)',
    p1.mp < 9 && Math.abs(p1.mn) < 9,
    `pos=${p1.mp.toFixed(2)}V neg=${p1.mn.toFixed(2)}V`,
  );

  // 连续性:无孤立单样本尖峰
  const { y } = captureStage(0.5, 0.5, 550, 19200);
  let spikes = 0;
  for (let i = 1; i < y.length - 1; i++) {
    const d0 = y[i] - y[i - 1];
    const d1 = y[i + 1] - y[i];
    if (Math.abs(d0) > 0.2 && Math.abs(d1) > 0.2 && Math.sign(d0) !== Math.sign(d1)) spikes++;
  }
  check('波形连续(无孤立尖峰)', spikes === 0, `spikes=${spikes}`);

  // 宽带 RMS 标定(供效果器 output.gain 归一化:默认 w=0.5 接通≈旁通响度)
  const chain = makeChain(0.5);
  const riffFreqs = [82, 110, 165, 220, 330, 440, 660, 880];
  const settle = Math.floor(BASE * 0.5);
  const N2 = BASE / 2;
  let sumIn = 0, sumOut = 0;
  for (let i = 0; i < settle + N2; i++) {
    let x = 0;
    for (const f of riffFreqs) x += 0.02 * Math.sin((2 * Math.PI * f * i) / BASE);
    const yv = chain.process(x);
    if (i >= settle) {
      sumIn += x * x;
      sumOut += yv * yv;
    }
  }
  const rmsGain = Math.sqrt(sumOut / sumIn);
  console.log(`    宽带 RMS 增益(多音 riff,w=0.5): ${rmsGain.toFixed(3)} (${(20 * Math.log10(rmsGain)).toFixed(1)}dB)`);
}

// ---------- L2 小信号扫频(谐振峰轨迹) ----------
console.log('L2 小信号扫频(1mV,谐振峰频率/增益轨迹)');
{
  // 10Hz 整数倍 → N=19200(0.1s)整周期
  const freqs = [
    100, 150, 200, 250, 300, 350, 400, 450, 500, 550, 600, 650, 700, 750, 800, 850, 900, 950,
    1000, 1100, 1200, 1300, 1400, 1500, 1600, 1800, 2000, 2200, 2500, 3000, 3500, 4000, 5000,
  ];
  const positions = [0, 0.25, 0.5, 0.75, 0.9, 1];
  const peaks: { w: number; f: number; g: number; db: number }[] = [];
  for (const w of positions) {
    let best = { f: 0, g: 0 };
    for (const f of freqs) {
      const { y } = captureStage(w, 0.001, f, 19200);
      const g = goertzelOS(y, f) / 0.001;
      if (g > best.g) best = { f, g };
    }
    peaks.push({ w, f: best.f, g: best.g, db: 20 * Math.log10(best.g) });
  }
  for (const p of peaks) {
    console.log(`    w=${p.w}: peak=${p.f}Hz ${p.db.toFixed(1)}dB (${p.g.toFixed(2)}x)`);
  }
  // ngspice 同网表 AC 实测:w=0→464Hz/14.5dB,w=0.9→1307Hz/9.8dB,w=1→3830Hz/9.0dB 宽架
  check('w=0 峰频 400~550Hz', peaks[0].f >= 400 && peaks[0].f <= 550, `${peaks[0].f}Hz`);
  check('w=0 峰增益 12~20dB', peaks[0].db >= 12 && peaks[0].db <= 20, `${peaks[0].db.toFixed(1)}dB`);
  check('w=0.9 峰频 1.0~1.6kHz', peaks[4].f >= 1000 && peaks[4].f <= 1600, `${peaks[4].f}Hz`);
  check('w=0.9 峰增益 ≥9dB(Q2 接近截止,增益开始回落)', peaks[4].db >= 9 && peaks[4].db <= 20, `${peaks[4].db.toFixed(1)}dB`);
  const mono = peaks.slice(0, 5).every((p, i, a) => i === 0 || p.f > a[i - 1].f);
  check(
    '峰频随 w 单调上移(w=0→0.9)',
    mono,
    peaks.slice(0, 5).map((p) => `${p.w}:${p.f}`).join(' '),
  );
  // w=1(电气极限):Q2 失去偏置截止,Miller 反馈消失,响应退化为宽架——
  // ngspice 同网表同样如此(3830Hz/9.0dB);真实踏板机械行程到不了这里。
  check(
    'w=1 顶位为宽架(峰频 >2kHz,Q2 截止的电路真实行为)',
    peaks[5].f > 2000,
    `peak=${peaks[5].f}Hz ${peaks[5].db.toFixed(1)}dB(ngspice: 3830Hz/9.0dB)`,
  );
}

// ---------- L3 非线性行为 ----------
console.log('L3 非线性行为(w=0.5,550Hz 谐振峰,THD 随幅度单调性)');
{
  const thds = [0.005, 0.02, 0.1, 0.3].map((amp) => {
    const { y } = captureStage(0.5, amp, 550, 19200);
    return { amp, ...thdOS(y, 550) };
  });
  for (const t of thds) {
    console.log(`    ${t.amp}V: THD=${(t.thd * 100).toFixed(2)}% H2/H3=${t.h2h3.toFixed(2)}`);
  }
  const mono = thds.every((t, i) => i === 0 || t.thd >= thds[i - 1].thd - 1e-6);
  check('THD 随输入幅度单调上升', mono, thds.map((t) => `${t.amp}V:${(t.thd * 100).toFixed(2)}%`).join(' '));
  check('小驱动低失真(5mV THD <1%)', thds[0].thd < 0.01, `${(thds[0].thd * 100).toFixed(2)}%`);
  check('大驱动失真显著(0.3V THD >1%)', thds[3].thd > 0.01, `${(thds[3].thd * 100).toFixed(2)}%`);
}

// ---------- worklet 装配串一致性 ----------
console.log('worklet 装配串与 dsp.js 直驱链逐样本一致');
{
  // ADR-0003 后 worklet 与评测共享同一 dsp.js;此处验证 ?raw 装配串
  // (实际发给 AudioWorklet 的代码)在 shim 中与直驱链输出一致
  const { ctor: Ctor } = extractAssembledProcessor(
    'src/audio/wdf/crybabyWorklet.ts',
    buildProcessorSource,
  );
  const proc = new Ctor();
  // 驱动:0.3s 激励(含 0.2s 建立);WebAudio 结构:inputs[io][channel]
  const chain = makeChain(0.5);
  const N3 = Math.floor(BASE * 0.3);
  const inCh = new Float32Array(N3);
  const outCh = new Float32Array(N3);
  for (let i = 0; i < N3; i++) inCh[i] = 0.05 * Math.sin((2 * Math.PI * 1000 * i) / BASE);
  proc.process([[inCh]], [[outCh]], { position: [50], level: [1] });
  let maxDiff = 0;
  for (let i = 0; i < N3; i++) maxDiff = Math.max(maxDiff, Math.abs(outCh[i] - chain.process(inCh[i])));
  // Float32 vs Float64 精度 + 重采样器初始相位应完全一致
  check('worklet 装配串与直驱链输出一致(maxDiff < 1e-4)', maxDiff < 1e-4, `maxDiff=${maxDiff.toExponential(2)}`);
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项未过 ✗`);
if (failures > 0) process.exit(1);
