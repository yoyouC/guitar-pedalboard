/**
 * Fuzz Face WDF 正确性评测(L0~L3,Node 直跑:node scripts/wdf-fuzzface-eval.ts)
 * 对照基准:R.G. Keen "The Technology of the Fuzz Face" 电路行为:
 *   电压反馈偏置(Vc1≈0.5~0.7V,Vc2≈4.5V)、不对称→趋于对称的削波、
 *   低输入阻抗(guitar volume cleanup)、FUZZ=发射极旁路程度控制增益。
 * 另含 worklet 内联实现与 TS 参考的逐样本一致性检查。
 */
import { readFileSync } from 'node:fs';
import { FuzzFaceStage } from '../src/audio/wdf/fuzzFaceStage.ts';
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from '../src/audio/wdf/resample.ts';

const BASE = 48000;
const FS = BASE * OS_FACTOR;

/** 与 worklet 同构的完整链(升采样 → 放大级 → 降采样) */
function makeChain(fuzz: number) {
  const stage = new FuzzFaceStage({ fs: FS });
  stage.setFuzz(fuzz);
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

/** OS 速率整周期 Goertzel(N 必须为 192000/f 的整数倍) */
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

/** 直接驱动放大级:0.6s 建立(≥0.5s 规范)后采 N 个 OS 样本 */
function captureStage(fuzz: number, amp: number, freq: number, n: number, Rs?: number) {
  const s = new FuzzFaceStage({ fs: FS, ...(Rs !== undefined ? { Rs } : {}) });
  s.setFuzz(fuzz);
  const settle = Math.floor(FS * 0.6);
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
  // 全参数空间扫掠:fuzz 慢扫 × 多幅度 × 多频率
  let nan = 0, maxAbs = 0, totalNC = 0, totalIter = 0, totalCnt = 0;
  for (const amp of [0.01, 0.1, 0.5, 1.0, 2.0]) {
    for (const freq of [100, 1000, 5000]) {
      const s = new FuzzFaceStage({ fs: FS });
      const M = FS / 4;
      for (let i = 0; i < M; i++) {
        s.setFuzz(0.5 + 0.5 * Math.sin((2 * Math.PI * i) / M));
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
  const s2 = new FuzzFaceStage({ fs: FS });
  for (let i = 0; i < FS; i++) s2.process(0);
  let silentMax = 0;
  for (let i = 0; i < FS / 10; i++) silentMax = Math.max(silentMax, Math.abs(s2.process(0)));
  check('静音→静音(无极限环)', silentMax < 1e-9, `silentMax=${silentMax.toExponential(1)}`);

  // 偏置点(对照 ngspice OP:vb1=0.197 vc1=0.705 ve2=0.491 vc2=4.773)
  const s3 = new FuzzFaceStage({ fs: FS });
  for (let i = 0; i < FS / 10; i++) s3.process(0);
  const st = s3 as unknown as { vb1: number; vc1: number; ve2: number; vc2: number };
  const biasOk =
    Math.abs(st.vb1 - 0.197) < 0.05 && Math.abs(st.vc1 - 0.705) < 0.15 &&
    Math.abs(st.ve2 - 0.491) < 0.1 && Math.abs(st.vc2 - 4.773) < 0.3;
  check(
    'DC 偏置 ≈ spice OP(电压反馈偏置)',
    biasOk,
    `vb1=${st.vb1.toFixed(3)} vc1=${st.vc1.toFixed(3)} ve2=${st.ve2.toFixed(3)} vc2=${st.vc2.toFixed(3)}`,
  );
}

// ---------- L1 传输特性(动态,1kHz 幅度扫描) ----------
console.log('L1 传输特性(fuzz=0.5,1kHz 幅度扫描)');
{
  const peaks = (amp: number) => {
    const { y } = captureStage(0.5, amp, 1000, 19200);
    let mp = 0, mn = 0;
    for (const v of y) {
      mp = Math.max(mp, v);
      mn = Math.min(mn, v);
    }
    return { mp, mn };
  };
  const p5m = peaks(0.005);
  const p50m = peaks(0.05);
  const p500m = peaks(0.5);
  check(
    '软削波:输出峰值饱和(0.5V 输入峰值 <6V)',
    p500m.mp < 6 && p500m.mp > 2,
    `pos=${p500m.mp.toFixed(2)}V neg=${p500m.mn.toFixed(2)}V`,
  );
  check(
    '增益压缩(峰值比 0.5V/0.05V < 1.5)',
    p500m.mp / p50m.mp < 1.5,
    `ratio=${(p500m.mp / p50m.mp).toFixed(2)}`,
  );
  const asymHi = Math.abs(p500m.mp + p500m.mn) / (p500m.mp - p500m.mn);
  check(
    '大驱动不对称削波(Keen:不对称;0.02<asym<0.6)',
    asymHi > 0.02 && asymHi < 0.6,
    `asym=${asymHi.toFixed(3)}`,
  );
  const asymLo = Math.abs(p5m.mp + p5m.mn) / Math.max(1e-12, p5m.mp - p5m.mn);
  check('小驱动近对称(asym < 0.02)', asymLo < 0.02, `asym=${asymLo.toFixed(4)}`);

  // 连续性:无孤立单样本尖峰(求解器跳变的特征是 V 形反转;
  // 静态模型无结电容,削波沿本身陡峭但单调平滑,不算跳变)
  const { y } = captureStage(0.5, 0.2, 1000, 19200);
  let spikes = 0;
  let jump = 0;
  for (let i = 1; i < y.length - 1; i++) {
    const d0 = y[i] - y[i - 1];
    const d1 = y[i + 1] - y[i];
    jump = Math.max(jump, Math.abs(d0));
    if (Math.abs(d0) > 0.2 && Math.abs(d1) > 0.2 && Math.sign(d0) !== Math.sign(d1)) spikes++;
  }
  check('波形连续(无孤立尖峰)', spikes === 0, `spikes=${spikes} (削波沿最大斜率 ${jump.toFixed(2)}V/样本,模型真值)`);
}

// ---------- L2 线性区频响 ----------
console.log('L2 线性区频响(fuzz=0,1mV 小信号;Cin 输入高通)');
{
  const freqs = [20, 40, 80, 160, 400, 1000, 4000];
  const gains = freqs.map((f) => {
    const { y } = captureStage(0, 0.001, f, 19200);
    return { f, g: goertzelOS(y, f) / 0.001 };
  });
  const g1k = gains.find((x) => x.f === 1000)!;
  check('中频增益合理(30~200)', g1k.g > 30 && g1k.g < 200, `gain=${g1k.g.toFixed(1)}`);
  const g20 = gains.find((x) => x.f === 20)!;
  const g40 = gains.find((x) => x.f === 40)!;
  const g400 = gains.find((x) => x.f === 400)!;
  const g4k = gains.find((x) => x.f === 4000)!;
  check(
    '低频高通滚降(1k/20Hz > 1.5,且 40Hz>20Hz)',
    g1k.g / g20.g > 1.5 && g40.g > g20.g,
    `20Hz=${g20.g.toFixed(1)} 40Hz=${g40.g.toFixed(1)} 1k=${g1k.g.toFixed(1)} (${(20 * Math.log10(g1k.g / g20.g)).toFixed(1)}dB)`,
  );
  check(
    '中频平坦(400Hz~4kHz 偏差 <10%;未建模结电容,HF 不衰落)',
    Math.abs(g400.g / g1k.g - 1) < 0.1 && Math.abs(g4k.g / g1k.g - 1) < 0.1,
    `400Hz=${g400.g.toFixed(1)} 1k=${g1k.g.toFixed(1)} 4k=${g4k.g.toFixed(1)}`,
  );
}

// ---------- L3 非线性行为 ----------
console.log('L3 非线性行为');
{
  // THD 随 fuzz 单调上升(20mV 1kHz,整周期 N=19200=100 周期)
  const thds = [0.05, 0.2, 0.4, 0.6, 0.8, 1.0].map((fz) => {
    const { y } = captureStage(fz, 0.02, 1000, 19200);
    return { fz, ...thdOS(y, 1000) };
  });
  const mono = thds.every((t, i) => i === 0 || t.thd >= thds[i - 1].thd - 1e-6);
  check(
    'THD 随 FUZZ 上升',
    mono,
    thds.map((t) => `f${t.fz}:${(t.thd * 100).toFixed(1)}%`).join(' '),
  );
  // 偶次谐波主导(不对称削波特征,与 TS808 的奇次主导相反)
  const h2h3Mild = thds[1].h2h3; // fuzz=0.2
  check('轻度区偶次谐波显著(H2/H3 > 1,不对称削波)', h2h3Mild > 1, `H2/H3=${h2h3Mild.toFixed(2)}`);
  // fuzz=1 深度失真
  check('fuzz=1 深度失真(THD > 20%)', thds[5].thd > 0.2, `THD=${(thds[5].thd * 100).toFixed(1)}%`);

  // 触感(输入幅度 → 失真度)
  const tSoft = thdOS(captureStage(0.5, 0.005, 1000, 19200).y, 1000).thd;
  const tHard = thdOS(captureStage(0.5, 0.2, 1000, 19200).y, 1000).thd;
  check(
    '触感响应(THD 随输入幅度显著上升)',
    tHard > tSoft * 5,
    `5mV:${(tSoft * 100).toFixed(2)}% → 200mV:${(tHard * 100).toFixed(2)}%`,
  );

  // 输入阻抗清理(guitar volume cleanup):源内阻增大 → 失真骤降
  const tLowZ = thdOS(captureStage(0.5, 0.05, 1000, 19200, 1000).y, 1000).thd;
  const tHighZ = thdOS(captureStage(0.5, 0.05, 1000, 19200, 47000).y, 1000).thd;
  check(
    'cleanup:大源内阻显著降低失真(模拟吉他音量关小)',
    tHighZ < tLowZ / 5,
    `Rs=1k:${(tLowZ * 100).toFixed(1)}% → Rs=47k:${(tHighZ * 100).toFixed(2)}%`,
  );
}

// ---------- worklet 内联实现一致性 ----------
console.log('worklet 内联 JS 与 TS 参考逐样本一致');
{
  // 从 worklet 文件提取 processorSource,在 shim 环境中实例化处理器
  const src = readFileSync('src/audio/wdf/fuzzfaceWorklet.ts', 'utf-8');
  const m = src.match(/const processorSource = `([\s\S]*?)`;\n\nlet loaded/);
  if (!m) {
    check('提取 processorSource', false, '正则未匹配');
  } else {
    let captured: unknown = null;
    class ShimAWP {}
    const registerProcessor = (_name: string, ctor: unknown) => {
      captured = ctor;
    };
    const run = new Function(
      'AudioWorkletProcessor',
      'registerProcessor',
      'sampleRate',
      m[1],
    );
    run(ShimAWP, registerProcessor, BASE);
    const Ctor = captured as new () => {
      chains: unknown[];
      process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, number[]>): boolean;
    };
    const proc = new Ctor();
    // 驱动:0.3s 激励(含 0.2s 建立);WebAudio 结构:inputs[io][channel]
    const chain = makeChain(0.7);
    const N = Math.floor(BASE * 0.3);
    const inCh = new Float32Array(N);
    const outCh = new Float32Array(N);
    for (let i = 0; i < N; i++) inCh[i] = 0.05 * Math.sin((2 * Math.PI * 1000 * i) / BASE);
    proc.process([[inCh]], [[outCh]], { fuzz: [70], level: [1] });
    let maxDiff = 0;
    for (let i = 0; i < N; i++) maxDiff = Math.max(maxDiff, Math.abs(outCh[i] - chain.process(inCh[i])));
    // Float32 vs Float64 精度 + 重采样器初始相位应完全一致
    check('worklet 与 TS 输出一致(maxDiff < 1e-4)', maxDiff < 1e-4, `maxDiff=${maxDiff.toExponential(2)}`);
  }
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项未过 ✗`);
if (failures > 0) process.exit(1);
