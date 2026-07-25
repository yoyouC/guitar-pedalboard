/**
 * 磁带延迟(EP-3 风格)正确性评测(L0~L3,Node 直跑:node scripts/wdf-tapedelay-eval.ts)
 * 特征对照:
 *   录制软削波(磁带饱和)/ wow(0.8Hz)+flutter(6.4Hz)周期音高漂移 /
 *   每次重复高频损失 + 逐次饱和 / FEEDBACK>100% 自激振荡但有界不发散。
 * 测量规范:≥0.5s 建立期;Goertzel/DFT 窗一律取被测频率整数周期(见 docs/wdf-whitebox-process.md §4)。
 */
import {
  TapeDelayEngine,
  TAPE_WOW_HZ,
  TAPE_FLUTTER_HZ,
} from '../src/audio/wdf/tapeDelay.ts';

const FS = 48000;
const SETTLE = Math.ceil(0.5 * FS); // 建立期样本数(TIME 平滑/延迟线填充)

interface Knobs {
  time?: number;
  feedback?: number;
  wow?: number;
  saturation?: number;
  mix?: number;
}

function makeEngine(p: Knobs): TapeDelayEngine {
  const e = new TapeDelayEngine(FS);
  if (p.time !== undefined) e.setTime(p.time);
  if (p.feedback !== undefined) e.setFeedback(p.feedback);
  if (p.wow !== undefined) e.setWow(p.wow);
  if (p.saturation !== undefined) e.setSaturation(p.saturation);
  if (p.mix !== undefined) e.setMix(p.mix);
  return e;
}

function run(e: TapeDelayEngine, input: Float64Array): Float64Array {
  const out = new Float64Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = e.process(input[i]);
  return out;
}

/** 湿路 = 输出 - 干路(mix=100 时即 out - in) */
function wetOnly(out: Float64Array, inp: Float64Array): Float64Array {
  const wet = new Float64Array(out.length);
  for (let i = 0; i < out.length; i++) wet[i] = out[i] - inp[i];
  return wet;
}

function sine(freq: number, amp: number, n: number): Float64Array {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = amp * Math.sin((2 * Math.PI * freq * i) / FS);
  return y;
}

function rms(y: Float64Array, a: number, b: number): number {
  let s = 0;
  for (let i = a; i < b; i++) s += y[i] * y[i];
  return Math.sqrt(s / (b - a));
}

/** 单频点幅度(Goertzel),窗长须为 freq 整数周期 */
function goertzel(y: Float64Array, a: number, n: number, freq: number): number {
  const w = (2 * Math.PI * freq) / FS;
  let re = 0,
    im = 0;
  for (let i = 0; i < n; i++) {
    re += y[a + i] * Math.cos(w * i);
    im -= y[a + i] * Math.sin(w * i);
  }
  return (2 * Math.hypot(re, im)) / n;
}

function thdAt(y: Float64Array, a: number, n: number, fund: number): number {
  const f1 = goertzel(y, a, n, fund);
  let s = 0;
  for (let h = 2; h <= 6; h++) {
    const g = goertzel(y, a, n, fund * h);
    s += g * g;
  }
  return Math.sqrt(s) / Math.max(1e-12, f1);
}

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}: ${detail}`);
  if (!ok) failures++;
}

// ---------- L0 健康 ----------
console.log('L0 健康(无 NaN / 有界 / 静音→静音 / 参数全程扫掠)');
{
  // a) 参数全程扫掠(含 TIME 全程、FEEDBACK 到 110)
  const e = makeEngine({ mix: 100 });
  let nan = 0,
    maxAbs = 0;
  const N = 6 * FS;
  const tri = (v: number): number => 2 * Math.abs(v - Math.floor(v + 0.5));
  for (let i = 0; i < N; i++) {
    if (i % 64 === 0) {
      const t = i / FS;
      e.setTime(50 + 950 * tri(t / 1.5));
      e.setFeedback(55 + 55 * Math.sin((2 * Math.PI * t) / 2.3));
      e.setWow(50 + 50 * Math.sin((2 * Math.PI * t) / 1.7));
      e.setSaturation(50 + 50 * Math.sin((2 * Math.PI * t) / 1.3));
      e.setMix(50 + 50 * Math.sin((2 * Math.PI * t) / 0.9));
    }
    const out = e.process(0.8 * Math.sin((2 * Math.PI * 1000 * i) / FS));
    if (!Number.isFinite(out)) nan++;
    const a = Math.abs(out);
    if (a > maxAbs) maxAbs = a;
  }
  check('参数全程扫掠无 NaN', nan === 0, `nan=${nan}`);
  check('参数全程扫掠有界(<6)', maxAbs < 6, `maxAbs=${maxAbs.toFixed(2)}`);

  // b) 静音→静音(0 是精确不动点;wow/fb=110 也不应凭空起振)
  const e2 = makeEngine({ wow: 100, feedback: 110, saturation: 100, mix: 100 });
  let silentMax = 0;
  for (let i = 0; i < FS; i++) silentMax = Math.max(silentMax, Math.abs(e2.process(0)));
  check('静音→静音(无极限环/误自激)', silentMax < 1e-9, `silentMax=${silentMax.toExponential(1)}`);

  // c) FEEDBACK=110 + 大信号:有界
  const e3 = makeEngine({ time: 200, feedback: 110, saturation: 0, mix: 100 });
  let nan3 = 0,
    max3 = 0;
  for (let i = 0; i < 8 * FS; i++) {
    const x = i < 2 * FS ? 0.9 * Math.sin((2 * Math.PI * 500 * i) / FS) : 0;
    const out = e3.process(x);
    if (!Number.isFinite(out)) nan3++;
    max3 = Math.max(max3, Math.abs(out));
  }
  check('FEEDBACK=110 输入 0.9 无 NaN', nan3 === 0, `nan=${nan3}`);
  check('FEEDBACK=110 输出有界(<4)', max3 < 4, `maxAbs=${max3.toFixed(2)}`);
}

// ---------- L1 特征指标 ----------
console.log('L1 特征指标(延迟时间准确 / 录制饱和 THD / 反馈衰减比)');
{
  // a) 延迟时间准确:冲激(建立期后),wow=0/sat=0/fb=0/mix=100
  const wetPeak = (timeMs: number): { peak: number; amp: number } => {
    const e = makeEngine({ time: timeMs, feedback: 0, wow: 0, saturation: 0, mix: 100 });
    const N = SETTLE + Math.ceil((timeMs / 1000 + 0.15) * FS);
    const inp = new Float64Array(N);
    inp[SETTLE] = 0.5;
    const wet = wetOnly(run(e, inp), inp);
    let peak = SETTLE,
      amp = 0;
    for (let i = SETTLE; i < N; i++) {
      const a = Math.abs(wet[i]);
      if (a > amp) {
        amp = a;
        peak = i;
      }
    }
    return { peak: peak - SETTLE, amp };
  };
  const ds = [50, 200, 700, 1000];
  const res = ds.map((d) => wetPeak(d));
  const latSamp = res[0].peak - 0.05 * FS; // Up/Down FIR 群延迟
  check(
    '链路附加延迟(重采样 FIR)在 [0,2]ms',
    latSamp >= 0 && latSamp <= (2 * FS) / 1000,
    `lat=${((latSamp / FS) * 1000).toFixed(3)}ms`,
  );
  const relErrs = ds.map((d, i) => (Math.abs(res[i].peak - latSamp - (d / 1000) * FS) / FS) * 1000);
  check(
    'TIME 准确(50~1000ms,相对误差 ≤1ms)',
    relErrs.every((v) => v <= 1),
    relErrs.map((v, i) => `${ds[i]}ms:${v.toFixed(3)}`).join(' '),
  );
  check(
    '首重复幅度可测(>0.1)',
    res.every((r) => r.amp > 0.1),
    res.map((r) => r.amp.toFixed(2)).join(' '),
  );

  // b) 录制饱和 THD(1kHz 0.8,湿路,4800 样本 = 100 整周期)
  const thds = [0, 25, 50, 75, 100].map((sat) => {
    const e = makeEngine({ time: 300, feedback: 0, wow: 0, saturation: sat, mix: 100 });
    const N = 4800;
    const inp = sine(1000, 0.8, SETTLE + N);
    const out = run(e, inp);
    const wet = wetOnly(out.subarray(SETTLE), inp.subarray(SETTLE));
    return { sat, thd: thdAt(wet, 0, N, 1000) };
  });
  const mono = thds.every((t, i) => i === 0 || t.thd >= thds[i - 1].thd - 1e-6);
  check(
    '录制饱和:THD 随 SATURATION 单调上升',
    mono,
    thds.map((t) => `s${t.sat}:${(t.thd * 100).toFixed(1)}%`).join(' '),
  );
  check('SAT=0 近透明(THD<0.5%)', thds[0].thd < 0.005, `${(thds[0].thd * 100).toFixed(2)}%`);
  check('SAT=100 明显饱和(THD≥5%)', thds[4].thd >= 0.05, `${(thds[4].thd * 100).toFixed(1)}%`);

  // c) FEEDBACK 衰减比(1kHz 10ms burst,每次重复峰值)
  const burstPeaks = (fb: number): number[] => {
    const e = makeEngine({ time: 200, feedback: fb, wow: 0, saturation: 0, mix: 100 });
    const N = SETTLE + FS;
    const inp = new Float64Array(N);
    for (let i = 0; i < 480; i++)
      inp[SETTLE + i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / FS);
    const wet = wetOnly(run(e, inp), inp);
    const peaks: number[] = [];
    for (let k = 1; k <= 3; k++) {
      const a = SETTLE + Math.round(k * 0.2 * FS) - 100;
      const b = SETTLE + Math.round(k * 0.2 * FS) + 1200;
      let m = 0;
      for (let i = a; i < b; i++) m = Math.max(m, Math.abs(wet[i]));
      peaks.push(m);
    }
    return peaks;
  };
  const p60 = burstPeaks(60);
  const r31 = p60[2] / p60[0];
  check(
    '反馈衰减比 p3/p1 ≈ fb²(0.2~0.5)',
    r31 > 0.2 && r31 < 0.5,
    `p1=${p60[0].toFixed(3)} p2=${p60[1].toFixed(3)} p3=${p60[2].toFixed(3)} 比=${r31.toFixed(3)}`,
  );
  const p0 = burstPeaks(0);
  check(
    'FEEDBACK=0 仅单次重复(p2/p1<1%)',
    p0[1] / p0[0] < 0.01,
    `p2/p1=${(p0[1] / p0[0]).toExponential(1)}`,
  );
}

// ---------- L2 行为特征 ----------
console.log('L2 行为特征(wow/flutter 音高漂移 / 高频逐次衰减 / 有界自激)');
{
  // a) I/Q 解调瞬时延迟 D(t),DFT 测摆动频率与深度
  const measureWobble = (
    wowKnob: number,
  ): { wowHz: number; wowMs: number; flMs: number } => {
    const e = makeEngine({ time: 300, feedback: 0, wow: wowKnob, saturation: 0, mix: 100 });
    const f0 = 3000;
    const secs = 5;
    const N = secs * FS;
    const M = 80; // 5 个 f0 整周期滑动平均(整数周期陷波 2f0 纹波)
    const ringI = new Float64Array(M),
      ringQ = new Float64Array(M);
    let sumI = 0,
      sumQ = 0;
    const phase = new Float64Array(N);
    let prevPh = 0,
      off = 0,
      started = false;
    const settle = Math.ceil(0.6 * FS);
    for (let i = 0; i < settle + N; i++) {
      const x = 0.6 * Math.sin((2 * Math.PI * f0 * i) / FS);
      const wet = e.process(x) - x;
      const ph = (2 * Math.PI * f0 * i) / FS;
      const ri = 2 * wet * Math.cos(ph),
        rq = -2 * wet * Math.sin(ph);
      const idx = i % M;
      sumI += ri - ringI[idx];
      ringI[idx] = ri;
      sumQ += rq - ringQ[idx];
      ringQ[idx] = rq;
      if (i >= settle) {
        const n = i - settle;
        const cur = Math.atan2(sumQ / M, sumI / M);
        if (!started) {
          prevPh = cur;
          started = true;
        }
        const dphi = cur - prevPh;
        if (dphi > Math.PI) off -= 2 * Math.PI;
        else if (dphi < -Math.PI) off += 2 * Math.PI;
        phase[n] = cur + off;
        prevPh = cur;
      }
    }
    // 抽取到 100Hz(480 样本 = 30 个 f0 周期),D̂ = phase/(2πf0)
    const dec = 480;
    const N2 = Math.floor(N / dec);
    const d = new Float64Array(N2);
    for (let k = 0; k < N2; k++) d[k] = phase[k * dec] / (2 * Math.PI * f0);
    // 线性去趋势(剔除恒定延迟与残坡)
    let sx = 0,
      sy = 0,
      sxx = 0,
      sxy = 0;
    for (let k = 0; k < N2; k++) {
      sx += k;
      sy += d[k];
      sxx += k * k;
      sxy += k * d[k];
    }
    const slope = (N2 * sxy - sx * sy) / (N2 * sxx - sx * sx);
    const intercept = (sy - slope * sx) / N2;
    for (let k = 0; k < N2; k++) d[k] -= intercept + slope * k;
    // DFT(bin = 0.2Hz,wow 0.8 与 flutter 6.4 均在整 bin)
    const ampAt = (hz: number): number => {
      const w = (2 * Math.PI * hz * secs) / N2;
      let re = 0,
        im = 0;
      for (let k = 0; k < N2; k++) {
        re += d[k] * Math.cos(w * k);
        im -= d[k] * Math.sin(w * k);
      }
      return (2 * Math.hypot(re, im)) / N2;
    };
    let wowHz = 0,
      wowAmp = 0;
    for (let hz = 0.4; hz <= 3.001; hz += 0.2) {
      const a = ampAt(hz);
      if (a > wowAmp) {
        wowAmp = a;
        wowHz = hz;
      }
    }
    return { wowHz, wowMs: wowAmp * 1000, flMs: ampAt(TAPE_FLUTTER_HZ) * 1000 };
  };

  const w100 = measureWobble(100);
  check(
    'wow=100 主摆动频率在 0.5~2Hz 带内(≈0.8Hz)',
    w100.wowHz >= 0.5 && w100.wowHz <= 2 && Math.abs(w100.wowHz - TAPE_WOW_HZ) <= 0.25,
    `f=${w100.wowHz.toFixed(2)}Hz`,
  );
  check(
    'wow=100 摆动深度 ≈3ms(2~4.2ms)',
    w100.wowMs >= 2 && w100.wowMs <= 4.2,
    `depth=${w100.wowMs.toFixed(2)}ms`,
  );
  check(
    `wow=100 flutter ${TAPE_FLUTTER_HZ}Hz 分量(0.15~0.7ms)`,
    w100.flMs >= 0.15 && w100.flMs <= 0.7,
    `flutter=${w100.flMs.toFixed(2)}ms`,
  );
  const w50 = measureWobble(50);
  check(
    'wow=50 深度减半(1~2.2ms)',
    w50.wowMs >= 1 && w50.wowMs <= 2.2,
    `depth=${w50.wowMs.toFixed(2)}ms`,
  );
  const w0 = measureWobble(0);
  check(
    'wow=0 无摆动(<0.12ms)',
    w0.wowMs < 0.12 && w0.flMs < 0.12,
    `wow=${w0.wowMs.toFixed(3)}ms flutter=${w0.flMs.toFixed(3)}ms`,
  );

  // b) 高频逐次衰减:冲激重复,G(4k)/G(800) 逐次下降(1200 样本 = 20/100 整周期)
  {
    const e = makeEngine({ time: 250, feedback: 65, wow: 0, saturation: 10, mix: 100 });
    const N = SETTLE + Math.ceil(1.3 * FS);
    const inp = new Float64Array(N);
    inp[SETTLE] = 0.5;
    const wet = wetOnly(run(e, inp), inp);
    let lat = SETTLE,
      m = 0;
    for (let i = SETTLE; i < SETTLE + Math.round(0.3 * FS); i++) {
      const a = Math.abs(wet[i]);
      if (a > m) {
        m = a;
        lat = i;
      }
    }
    const win = 1200;
    const ratios: number[] = [];
    for (let k = 0; k < 4; k++) {
      const a = lat + Math.round(k * 0.25 * FS) - win / 2;
      ratios.push(goertzel(wet, a, win, 4000) / Math.max(1e-12, goertzel(wet, a, win, 800)));
    }
    const monoDown = ratios.every((r, i) => i === 0 || r < ratios[i - 1]);
    check(
      '高频逐次衰减(4k/800 比单调下降)',
      monoDown,
      ratios.map((r, i) => `R${i + 1}=${r.toFixed(3)}`).join(' '),
    );
    check(
      '4 次重复后高频显著损失(r4/r1<0.55)',
      ratios[3] / ratios[0] < 0.55,
      `r4/r1=${(ratios[3] / ratios[0]).toFixed(3)}`,
    );
  }

  // c) 自激振荡:0.5s 500Hz 触发后静音,fb=110 持续有界,fb=50 迅速衰减
  {
    const burstThenSilence = (fb: number): { nan: number; mx: number; rmsA: number; rmsB: number } => {
      const e = makeEngine({ time: 200, feedback: fb, wow: 0, saturation: 50, mix: 100 });
      const N = 5 * FS;
      const wet = new Float64Array(N);
      let nan = 0,
        mx = 0;
      for (let i = 0; i < N; i++) {
        const x = i < FS / 2 ? 0.5 * Math.sin((2 * Math.PI * 500 * i) / FS) : 0;
        const out = e.process(x);
        if (!Number.isFinite(out)) nan++;
        mx = Math.max(mx, Math.abs(out));
        wet[i] = out - x;
      }
      const a0 = FS / 2;
      return {
        nan,
        mx,
        rmsA: rms(wet, a0 + Math.round(0.75 * FS), a0 + Math.round(1.25 * FS)),
        rmsB: rms(wet, a0 + Math.round(3.5 * FS), a0 + Math.round(4.0 * FS)),
      };
    };
    const osc = burstThenSilence(110);
    check(
      'FEEDBACK=110 自激:静音后 0.75~1.25s 仍响(rms>0.02)',
      osc.rmsA > 0.02,
      `rmsA=${osc.rmsA.toFixed(3)}`,
    );
    check(
      'FEEDBACK=110 自激持续(3.5~4s rms ≥ 0.3×rmsA)',
      osc.rmsB >= 0.3 * osc.rmsA,
      `rmsB=${osc.rmsB.toFixed(3)} (${(osc.rmsB / osc.rmsA).toFixed(2)}×)`,
    );
    check(
      'FEEDBACK=110 有界不发散(max<3,无 NaN)',
      osc.mx < 3 && osc.nan === 0,
      `max=${osc.mx.toFixed(2)} nan=${osc.nan}`,
    );
    const dec = burstThenSilence(50);
    check(
      'FEEDBACK=50 迅速衰减(rmsB < 0.005×rmsA)',
      dec.rmsB < 0.005 * dec.rmsA,
      `rmsA=${dec.rmsA.toFixed(4)} rmsB=${dec.rmsB.toExponential(2)}`,
    );
  }
}

// ---------- L3 非线性行为 ----------
console.log('L3 非线性行为(重复谐波失真 / 抗混叠)');
{
  // a) 重复含谐波失真:1kHz 30ms burst,第 2 次重复 960 样本窗(20 整周期)
  const repeatThd = (sat: number): number => {
    const e = makeEngine({ time: 250, feedback: 80, wow: 0, saturation: sat, mix: 100 });
    const N = SETTLE + Math.ceil(0.9 * FS);
    const inp = new Float64Array(N);
    for (let i = 0; i < 1440; i++)
      inp[SETTLE + i] = 0.7 * Math.sin((2 * Math.PI * 1000 * i) / FS);
    const wet = wetOnly(run(e, inp), inp);
    const a = SETTLE + Math.round(2 * 0.25 * FS) + 240; // 第 2 次重复内 5~25ms
    return thdAt(wet, a, 960, 1000);
  };
  const t0 = repeatThd(0);
  const t90 = repeatThd(90);
  check('SAT=90 重复含显著谐波失真(THD≥5%)', t90 >= 0.05, `${(t90 * 100).toFixed(1)}%`);
  check('SAT=0 重复近透明(THD<2%)', t0 < 0.02, `${(t0 * 100).toFixed(2)}%`);
  check('饱和重复失真远高于透明设置(>3×)', t90 > 3 * t0, `${(t90 / t0).toFixed(1)}×`);

  // b) 抗混叠:5kHz 0.9 深饱和,折叠镜像 bin(3/8/13/18/23k)vs 真实谐波(10/15/20k)
  {
    const e = makeEngine({ time: 300, feedback: 0, wow: 0, saturation: 100, mix: 100 });
    const N = 4800; // 500 个 5kHz 整周期,各镜像/谐波 bin 均整数
    const inp = sine(5000, 0.9, SETTLE + N);
    const out = run(e, inp);
    const wet = wetOnly(out.subarray(SETTLE), inp.subarray(SETTLE));
    const harm = Math.max(
      goertzel(wet, 0, N, 10000),
      goertzel(wet, 0, N, 15000),
      goertzel(wet, 0, N, 20000),
    );
    const alias = Math.max(
      ...[3000, 8000, 13000, 18000, 23000].map((f) => goertzel(wet, 0, N, f)),
    );
    const db = 20 * Math.log10(alias / Math.max(1e-12, harm));
    check('抗混叠:折叠镜像远低于真实谐波(<-40dB)', db < -40, `alias/harm=${db.toFixed(1)}dB`);
  }
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项未过 ✗`);
if (failures > 0) process.exit(1);
