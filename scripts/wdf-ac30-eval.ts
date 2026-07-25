/**
 * AC30 WDF 正确性评测(L0~L3,Node 直跑:node scripts/wdf-ac30-eval.ts)
 * 对照基准:Vox AC30 Top Boost 电路性格
 *   (级1 暖偏置 12AX7 / 级2 冷一点 + 部分旁路 / 阴极跟随器 / top-boost 音色
 *    在后级之前 / EL84 A 类热偏置 / 输出变压器 75Hz HP + 5.5kHz LP + 2.5kHz 临场峰)
 * 清音核心 = 动态余量:L3 显式量化"大输入不削波区"与"边缘压缩区"两个区间。
 * 测量规范:≥0.5s 建立期(§4.2);Goertzel 测频一律取采样窗整数周期。
 * 注:静音/L1 等用例必须先放完"开机涌流"(耦合电容/CF 阴极 61V 直流建立,
 * 物理上真实箱头开机同样 thump),稳态后再测。
 */
import {
  Ac30Chain,
  CathodeFollower,
  WdfTriodeStage,
  AC30,
  KOREN_EL84_APPROX,
  ac30Drive,
} from '../src/audio/wdf/ac30Core.ts';
import { korenPlateCurrent } from '../src/audio/wdf/triode.ts';
import { makeAntiAliasFIR, Upsampler4x, Decimator4x, OS_FACTOR } from '../src/audio/wdf/resample.ts';

const BASE = 48000;
const FS = BASE * OS_FACTOR;
const SETTLE = BASE / 2; // 0.5s 建立期(§4.2)
const SETTLE_OS = FS / 2;

/** 与 worklet 同构的完整链(4x 重采样 + Ac30Chain) */
function makeChain(gain: number, bass = 50, mid = 50, treble = 50, presence = 50) {
  const core = new Ac30Chain(FS, gain, bass, mid, treble, presence);
  const fir = makeAntiAliasFIR();
  const up = new Upsampler4x(fir);
  const down = new Decimator4x(fir);
  const osBuf = new Float32Array(OS_FACTOR);
  return {
    core,
    process(x: number): number {
      up.process(osBuf, x);
      const y0 = core.process(osBuf[0]);
      const y1 = core.process(osBuf[1]);
      const y2 = core.process(osBuf[2]);
      const y3 = core.process(osBuf[3]);
      return down.process(y0, y1, y2, y3);
    },
  };
}

/** 建立 0.5s 后采集 n 个样本(基率链) */
function settleAndCapture(
  chain: { process(x: number): number },
  freq: number,
  amp: number,
  n: number,
): Float64Array {
  for (let i = 0; i < SETTLE; i++) chain.process(amp * Math.sin((2 * Math.PI * freq * i) / BASE));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++)
    out[i] = chain.process(amp * Math.sin((2 * Math.PI * freq * (i + SETTLE)) / BASE));
  return out;
}

/** freq 整除 BASE 时的整周期窗长(≥minN) */
function cycleLen(freq: number, minN: number): number {
  const per = BASE / freq;
  if (!Number.isInteger(per)) throw new Error(`freq ${freq} 不整除 ${BASE}`);
  return per * Math.max(1, Math.ceil(minN / per));
}

/** 单频点幅度(Goertzel,整周期窗 = DFT 单 bin;fs 为 y 的采样率) */
function goertzel(y: Float64Array, freq: number, fs = BASE): number {
  const N = y.length;
  const w = (2 * Math.PI * freq) / fs;
  let re = 0, im = 0;
  for (let n = 0; n < N; n++) {
    re += y[n] * Math.cos(w * n);
    im -= y[n] * Math.sin(w * n);
  }
  return (2 * Math.hypot(re, im)) / N;
}

function thd(y: Float64Array, fund: number, fs = BASE) {
  const f1 = goertzel(y, fund, fs);
  const f2 = goertzel(y, fund * 2, fs);
  const f3 = goertzel(y, fund * 3, fs);
  const f4 = goertzel(y, fund * 4, fs);
  const f5 = goertzel(y, fund * 5, fs);
  return {
    thd: Math.sqrt(f2 * f2 + f3 * f3 + f4 * f4 + f5 * f5) / Math.max(1e-12, f1),
    h2h3: f2 / Math.max(1e-12, f3),
    f1,
  };
}

function rmsOf(y: Float64Array): number {
  let s = 0;
  for (const v of y) s += v * v;
  return Math.sqrt(s / y.length);
}

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}: ${detail}`);
  if (!ok) failures++;
}

// ---------- L0 求解器健康 ----------
console.log('L0 求解器健康');
{
  let nan = 0, maxAbs = 0;
  for (const gain of [0, 35, 70, 100]) {
    for (const amp of [0.05, 0.3, 2.0]) {
      const c = makeChain(gain);
      for (let i = 0; i < BASE / 4; i++) {
        const out = c.process(amp * Math.sin((2 * Math.PI * 1000 * i) / BASE));
        if (!Number.isFinite(out)) nan++;
        if (i > BASE / 8) maxAbs = Math.max(maxAbs, Math.abs(out));
      }
    }
  }
  check('全参数区无 NaN', nan === 0, `nan=${nan}`);
  check('输出有界(<1.2,含 2V 满激励)', maxAbs < 1.2, `maxAbs=${maxAbs.toFixed(3)}`);

  // 静音:先放 0.5s 开机涌流(物理 thump),稳态后必须静默(无极限环)。
  // 注:EL84 耦合 Co=1mF 对其 100k 交流负载以 τ=100s 充电,斜坡被变压器 HP
  // 微分成 ~3.5e-5 的确定性本底(−89dBFS,不可闻,非振荡)——故阈值取 1e-4。
  const silent = makeChain(50);
  for (let i = 0; i < SETTLE; i++) silent.process(0);
  let silentMax = 0;
  for (let i = 0; i < BASE / 10; i++) silentMax = Math.max(silentMax, Math.abs(silent.process(0)));
  check('静音→静音(稳态后,无极限环;pw-Co 斜坡本底 <1e-4)', silentMax < 1e-4,
    `silentMax=${silentMax.toExponential(1)}`);

  // CF:缓冲器性格 + 二分迭代统计
  const cf = new CathodeFollower({ fs: FS, Rk: 100e3, Rs: 69.4e3, Rload: 1.22e6, gridBias: 60 });
  let mn = 0, mx = 0;
  for (let i = 0; i < FS; i++) {
    const y = cf.process(Math.sin((2 * Math.PI * 1000 * i) / FS));
    if (i > FS / 2) {
      mn = Math.min(mn, y);
      mx = Math.max(mx, y);
    }
  }
  check('CF 近似透明(1V → ±0.9~1.0)', mn < -0.9 && mx > 0.9 && mx < 1.0, `[${mn.toFixed(3)}, ${mx.toFixed(3)}]`);
  const avgResid = cf.iterCount / FS;
  check('CF 二分残差求值数(平均 <16/样本)', avgResid < 16, `avg=${avgResid.toFixed(1)}`);

  // 稳健三极管级:20V 直接灌栅极(远超现实)不得炸
  const st = new WdfTriodeStage({ fs: FS });
  let nan2 = 0, mx2 = 0;
  for (let i = 0; i < FS / 10; i++) {
    const y = st.process(20 * Math.sin((2 * Math.PI * 1000 * i) / FS));
    if (!Number.isFinite(y)) nan2++;
    mx2 = Math.max(mx2, Math.abs(y));
  }
  check('WdfTriodeStage 20V 灌栅无 NaN、有界', nan2 === 0 && mx2 <= 300, `nan=${nan2} max=${mx2.toFixed(1)}`);
}

// ---------- L1 静态传输特性 ----------
console.log('L1 慢扫传输特性(100Hz,对非线性偏置电容准静态)');
{
  // DC 静态点参考(EL84 A 类热偏置)
  const dcIp = (() => {
    let ip = 1e-3;
    for (let i = 0; i < 60; i++) {
      const vk = ip * 150;
      const f = ip - korenPlateCurrent(KOREN_EL84_APPROX, -vk, 310 - ip * 4e3 - vk);
      const h = 1e-7;
      const vk2 = (ip + h) * 150;
      const df =
        (ip + h - korenPlateCurrent(KOREN_EL84_APPROX, -vk2, 310 - (ip + h) * 4e3 - vk2) - f) / h;
      ip -= f / df;
      if (ip < 0) ip = 0;
    }
    return ip;
  })();
  console.log(
    `    EL84 静态: ip=${(dcIp * 1000).toFixed(1)}mA vk=${(dcIp * 150).toFixed(2)}V ` +
      `vp=${(310 - dcIp * 4150).toFixed(0)}V(kg=${KOREN_EL84_APPROX.kg} 标定)`,
  );

  // 100Hz 慢扫(先 0.5s 建立,再测一个完整周期;100Hz 对 22µF 旁路等偏置网络准静态)
  const sweep = (gain: number, amp: number) => {
    const c = makeChain(gain);
    const per = BASE / 100;
    for (let i = 0; i < SETTLE; i++) c.process(amp * Math.sin((2 * Math.PI * i) / per));
    let maxPos = 0, maxNeg = 0, prev = 0, maxJump = 0;
    for (let i = 0; i < per; i++) {
      const out = c.process(amp * Math.sin((2 * Math.PI * (i + SETTLE)) / per));
      maxPos = Math.max(maxPos, out);
      maxNeg = Math.min(maxNeg, out);
      if (i > 0) maxJump = Math.max(maxJump, Math.abs(out - prev));
      prev = out;
    }
    return { maxPos, maxNeg, maxJump };
  };

  // 清音区(gain=20,0.5V:100Hz 处 HP 损耗 ×0.34 后栅极 ≈0.48V,各级均在线性区):
  // 连续、近对称、不削平
  const clean = sweep(20, 0.5);
  const asymC = Math.abs(clean.maxPos + clean.maxNeg) / (clean.maxPos - clean.maxNeg);
  check('清音区连续无跳变', clean.maxJump < 0.02, `maxJump=${clean.maxJump.toFixed(4)}`);
  check('清音区近对称(不对称度<0.15,容许偶次)', asymC < 0.15, `asym=${asymC.toFixed(3)}`);
  check('清音区不被削平(峰>0.04)', clean.maxPos > 0.04, `pos=${clean.maxPos.toFixed(3)}`);

  // 破音区(gain=100,0.5V):软压缩、有界、连续;峰值压缩量化
  const hot = sweep(100, 0.5);
  check('破音区连续无跳变', hot.maxJump < 0.05, `maxJump=${hot.maxJump.toFixed(4)}`);
  check('破音区峰值压缩(0.1<峰<0.7,软压非硬削)', hot.maxPos < 0.7 && hot.maxPos > 0.1,
    `pos=${hot.maxPos.toFixed(3)} neg=${hot.maxNeg.toFixed(3)}`);
  const asymH = Math.abs(hot.maxPos + hot.maxNeg) / (hot.maxPos - hot.maxNeg);
  check('破音区不对称在位(0.02~0.4,A 类偶次)', asymH > 0.02 && asymH < 0.4, `asym=${asymH.toFixed(3)}`);
}

// ---------- L2 线性区频响 ----------
console.log('L2 线性区频响(5mV 小信号,gain=35,OS 域直测,对照 75Hz HP / 2.5kHz 临场峰 / 5.5kHz LP)');
const gainAt = (freq: number, b = 50, m = 50, t = 50, p = 50) => {
  const c = new Ac30Chain(FS, 35, b, m, t, p);
  const amp = 5e-3;
  const per = FS / freq; // 本组频率均整除 FS
  const n = per * Math.max(1, Math.ceil(8192 / per));
  for (let i = 0; i < SETTLE_OS; i++) c.process(amp * Math.sin((2 * Math.PI * freq * i) / FS));
  let re = 0, im = 0;
  const w = (2 * Math.PI * freq) / FS;
  for (let i = 0; i < n; i++) {
    const out = c.process(amp * Math.sin((2 * Math.PI * freq * (i + SETTLE_OS)) / FS));
    re += out * Math.cos(w * i);
    im -= out * Math.sin(w * i);
  }
  return (2 * Math.hypot(re, im)) / n / amp;
};
const L2_FREQS = [40, 60, 75, 100, 150, 250, 500, 750, 1000, 1500, 2000, 2400, 3000, 4000, 4800, 6000, 8000, 9600, 12000, 16000];
const L2_TABLE = L2_FREQS.map((f) => ({ f, g: gainAt(f) }));
const L2_1K = L2_TABLE.find((x) => x.f === 1000)!.g;

{
  const db = (g: number) => 20 * Math.log10(g / L2_1K);
  console.log(`    相对 1kHz dB: ${L2_TABLE.map((x) => `${x.f}:${db(x.g).toFixed(1)}`).join(' ')}`);

  const at = (f: number) => L2_TABLE.find((x) => x.f === f)!.g;
  check('40Hz 衰减 ≥6dB(75Hz HP + 耦合)', db(at(40)) < -6, `${db(at(40)).toFixed(1)}dB`);
  check('75Hz 在 [-15,-8]dB(HP 级联:变压器 75Hz + 输入 60Hz + 耦合 34Hz×3 + 级2 部分旁路)',
    db(at(75)) > -15 && db(at(75)) < -8, `${db(at(75)).toFixed(1)}dB`);
  const bump = db(at(2400));
  check('2.4kHz 临场峰 +0.8~+4dB(chime)', bump > 0.8 && bump < 4, `+${bump.toFixed(2)}dB`);
  const topRegion = [1500, 2000, 2400, 3000, 4000];
  const argmax = topRegion.reduce((a, b) => (at(b) > at(a) ? b : a));
  check('频响峰在 2~3.4kHz 区(jangly 中高频)', argmax >= 2000 && argmax <= 3000, `peak=${argmax}Hz`);
  check('16kHz 衰减 ≥6dB vs 峰(5.5kHz LP)', db(at(16000)) - bump < -6, `${(db(at(16000)) - bump).toFixed(1)}dB`);
  const midAvg = (db(at(750)) + db(at(1000)) + db(at(1500)) + db(at(2400))) / 4;
  const lowAvg = (db(at(100)) + db(at(150)) + db(at(250))) / 3;
  check('中频自然突出(中频均值 > 低频均值 +4dB)', midAvg - lowAvg > 4, `${(midAvg - lowAvg).toFixed(1)}dB`);

  // 音色旋钮(在后级之前,平直=50)
  check('BASS=100 抬 100Hz ≥5dB', 20 * Math.log10(gainAt(100, 100) / at(100)) > 5,
    `${(20 * Math.log10(gainAt(100, 100) / at(100))).toFixed(1)}dB`);
  check('BASS=0 砍 100Hz ≥5dB', 20 * Math.log10(gainAt(100) / gainAt(100, 0)) > 5,
    `${(20 * Math.log10(gainAt(100) / gainAt(100, 0))).toFixed(1)}dB`);
  check('MID=100 抬 750Hz ≥4dB', 20 * Math.log10(gainAt(750, 50, 100) / at(750)) > 4,
    `${(20 * Math.log10(gainAt(750, 50, 100) / at(750))).toFixed(1)}dB`);
  check('TREBLE=100 抬 8kHz ≥4dB', 20 * Math.log10(gainAt(8000, 50, 50, 100) / at(8000)) > 4,
    `${(20 * Math.log10(gainAt(8000, 50, 50, 100) / at(8000))).toFixed(1)}dB`);
  check('PRESENCE=100 抬 9.6kHz ≥2.5dB', 20 * Math.log10(gainAt(9600, 50, 50, 50, 100) / at(9600)) > 2.5,
    `${(20 * Math.log10(gainAt(9600, 50, 50, 50, 100) / at(9600))).toFixed(1)}dB`);
}

// ---------- L3 非线性行为 ----------
console.log('L3 非线性行为');
{
  // THD 随 GAIN 单调上升(0.1V 1kHz)
  const thds = [10, 20, 35, 50, 65, 80, 100].map((g) => {
    const y = settleAndCapture(makeChain(g), 1000, 0.1, cycleLen(1000, 4800));
    return { g, ...thd(y, 1000) };
  });
  const mono = thds.every((t, i) => i === 0 || t.thd >= thds[i - 1].thd - 1e-6);
  check('THD 随 GAIN 单调上升', mono, thds.map((t) => `g${t.g}:${(t.thd * 100).toFixed(1)}%`).join(' '));

  // ===== 区间 1:大输入不削波区(动态余量量化)=====
  console.log('  —— 区间1:大输入不削波区(THD≤2% 的最大输入)——');
  const cleanHeadroom = (gain: number): number => {
    let maxClean = 0;
    for (const amp of [0.025, 0.05, 0.075, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5]) {
      const y = settleAndCapture(makeChain(gain), 1000, amp, cycleLen(1000, 4800));
      if (thd(y, 1000).thd <= 0.02) maxClean = amp;
      else break;
    }
    return maxClean;
  };
  const hr: Array<[number, number, number]> = []; // [gain, maxCleanV, 要求]
  for (const [gain, req] of [[0, 0.3], [20, 0.15], [30, 0.1], [50, 0.05]] as const) {
    const mc = cleanHeadroom(gain);
    hr.push([gain, mc, req]);
  }
  for (const [gain, mc, req] of hr) {
    check(`GAIN=${gain} 清音余量 ≥ ${req}V`, mc >= req, `maxClean=${mc}V`);
  }
  // 清音区波形完好性:crest factor ≈ 正弦 1.414(削顶会变低)
  {
    const y = settleAndCapture(makeChain(20), 1000, 0.15, cycleLen(1000, 4800));
    let peak = 0;
    for (const v of y) peak = Math.max(peak, Math.abs(v));
    const crest = peak / rmsOf(y);
    check('清音区波峰因数 1.35~1.5(无削顶)', crest > 1.35 && crest < 1.5, `crest=${crest.toFixed(3)}`);
  }

  // ===== 区间 2:边缘压缩区(A 类后级压缩量化)=====
  console.log('  —— 区间2:边缘压缩区(GAIN=60)——');
  const edge = (amp: number, gain = 60) => {
    const y = settleAndCapture(makeChain(gain), 1000, amp, cycleLen(1000, 4800));
    return { ...thd(y, 1000), rms: rmsOf(y) };
  };
  const e1 = edge(0.1);
  const e2 = edge(0.2);
  const e4 = edge(0.4);
  check('边缘区 THD 5~25%(音乐性破音,非 fuzz)', e2.thd > 0.05 && e2.thd < 0.25,
    `0.2V THD=${(e2.thd * 100).toFixed(1)}%`);
  // 压缩比:输入 ×2(+6dB)输出增幅(dB 域斜率,线性=1,硬限幅=0)
  const cr = (20 * Math.log10(e4.rms / e2.rms)) / 6;
  check('A 类渐进压缩(0.2→0.4V 压缩比 0.25~0.9)', cr > 0.25 && cr < 0.9,
    `CR=${cr.toFixed(2)} (rms ${e2.rms.toFixed(3)}→${e4.rms.toFixed(3)})`);
  check('边缘区偶次谐波在位(H2/H3 0.4~2,A 类签名)', e2.h2h3 > 0.4 && e2.h2h3 < 2.0,
    `H2/H3=${e2.h2h3.toFixed(2)}`);
  check('压缩渐进非突变(0.1→0.2V 仍增长 ≥1.4×)', e2.rms / e1.rms > 1.4,
    `ratio=${(e2.rms / e1.rms).toFixed(2)}`);

  // 频率选择性失真(表观 THD):100Hz 基波坐在 HP 级联斜坡上(−9.3dB),
  // 其 2~5 次谐波落在平坦区全通 → 输出侧表观 THD 低频显著高于 1kHz。
  // 物理对应:cranked AC30 低频"毛糙/发 woolly"的经典口碑。
  const rawThdAt = (freq: number, amp: number, gain: number) => {
    const y = settleAndCapture(makeChain(gain), freq, amp, cycleLen(freq, 4800));
    return thd(y, freq).thd;
  };
  const t100 = rawThdAt(100, 0.15, 40);
  const t1k = rawThdAt(1000, 0.15, 40);
  check('频率选择性失真(100Hz 表观 THD > 1kHz ×1.15,低频毛糙)', t100 > t1k * 1.15,
    `100Hz=${(t100 * 100).toFixed(1)}% vs 1kHz=${(t1k * 100).toFixed(1)}%`);

  // 混叠:整数周期 DFT,非谐波 bin 能量比(§4.3)
  {
    const N = 8192;
    const HARM_BIN = 171;
    const FREQ = (BASE * HARM_BIN) / N; // 1001.95Hz,采样窗整数倍
    const chain = makeChain(60);
    for (let i = 0; i < SETTLE; i++)
      chain.process(0.1 * Math.sin((2 * Math.PI * FREQ * i) / BASE));
    const y = new Float64Array(N);
    for (let i = 0; i < N; i++)
      y[i] = chain.process(0.1 * Math.sin((2 * Math.PI * FREQ * (i + SETTLE)) / BASE));
    const harmBins = new Set<number>();
    for (let h = 0; h * HARM_BIN < N / 2; h++)
      for (let d = -1; d <= 1; d++) harmBins.add(h * HARM_BIN + d);
    let eTotal = 0, eHarm = 0;
    for (let k = 1; k < N / 2; k++) {
      let re = 0, im = 0;
      for (let n = 0; n < N; n++) {
        const a = (-2 * Math.PI * k * n) / N;
        re += y[n] * Math.cos(a);
        im += y[n] * Math.sin(a);
      }
      const e = re * re + im * im;
      eTotal += e;
      if (harmBins.has(k)) eHarm += e;
    }
    const img = 10 * Math.log10(Math.max(1e-20, (eTotal - eHarm) / eTotal));
    check('混叠(非谐波能量比 < −45dB)', img < -45, `${img.toFixed(1)}dB`);
  }
}

console.log(`\ndrive 映射: gain 0/30/50/75/100 → ${[0, 30, 50, 75, 100].map((g) => ac30Drive(g).toFixed(1)).join('/')}`);
console.log(`NORM=${AC30.NORM};清音小信号增益(g35,1kHz)= ${L2_1K.toFixed(2)}(供 master 默认参考)`);
console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项未过 ✗`);
if (failures > 0) process.exit(1);
