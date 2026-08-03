/**
 * 哇音扫频稳定性复现:模拟 motion_midi 连续驱动 position,
 * 检查两种哇音实现是否在扫频后输出 NaN / 死寂。
 *
 * 用法: npx tsx scripts/debug-wah-sweep.ts
 */
import { CrybabyStage } from '../src/audio/wdf/crybabyStage.ts';

const FS = 48000;
const SECONDS = 20;
const N = FS * SECONDS;

// 输入:440Hz 双弦泛音混合,振幅 0.3(模拟测试音源)
const input = new Float64Array(N);
for (let i = 0; i < N; i++) {
  const t = i / FS;
  input[i] = 0.3 * (Math.sin(2 * Math.PI * 220 * t) + 0.5 * Math.sin(2 * Math.PI * 440 * t));
}

// motion_midi 式扫频:0.5Hz 正弦来回扫 0..100,经 setTargetAtTime 式的指数平滑(tc=0.015/0.03)
function sweptPosition(i: number, tc: number): number {
  const target = 50 + 50 * Math.sin(2 * Math.PI * 0.5 * (i / FS));
  return target; // 简化:直接给目标值,平滑在各自模型内部也无碍复现
  void tc;
}

// ---------- 1) crybaby-wah 谐振器(wahWorklet.ts 同款逐样本算法) ----------
function runResonator(): void {
  let s1 = 0, s2 = 0;
  let wSmooth = 0.5;
  const tc = 0.015;
  const alpha = 1 - Math.exp(-1 / (FS * tc));
  let maxAbs = 0, nanAt = -1;
  const rmsWindow: number[] = [];
  for (let i = 0; i < N; i++) {
    wSmooth += alpha * (sweptPosition(i) / 100 - wSmooth);
    const w = wSmooth;
    const Q = Math.pow(2, 2 * (1 - w) + 1) * 1;
    const fr = 450 * Math.pow(2, 2.3 * w);
    const frn = fr / FS;
    const R = 1 - (Math.PI * frn) / Q;
    const theta = 2 * Math.PI * frn;
    const a1 = -2 * R * Math.cos(theta);
    const a2 = R * R;
    const c1 = Math.cos(theta), c2 = Math.cos(2 * theta);
    const N2 = 2 - 2 * c1;
    const D2 = 1 + a1 * a1 + a2 * a2 + 2 * a1 * (1 + a2) * c1 + 2 * a2 * c2;
    const peakTarget = Math.pow(10, (14 + 6 * w) / 20);
    const b0 = peakTarget * Math.sqrt(D2 / N2);

    const x = input[i];
    const y = b0 * x + s1;
    s1 = -b0 * x - a1 * y + s2;
    s2 = -a2 * y;
    if (Number.isNaN(y) || !Number.isFinite(y)) { nanAt = i; break; }
    maxAbs = Math.max(maxAbs, Math.abs(y));
    rmsWindow.push(y * y);
    if (rmsWindow.length > 4800) rmsWindow.shift();
    if (i % (FS * 4) === 0 && i > 0) {
      const rms = Math.sqrt(rmsWindow.reduce((a, b) => a + b, 0) / rmsWindow.length);
      console.log(`  t=${(i / FS).toFixed(0)}s w=${w.toFixed(2)} b0=${b0.toFixed(2)} R=${R.toFixed(4)} rms=${rms.toFixed(4)}`);
    }
  }
  console.log(nanAt >= 0 ? `  ✗ 谐振器在 t=${(nanAt / FS).toFixed(2)}s 输出 NaN/Inf` : `  ✓ 谐振器 20s 稳定,maxAbs=${maxAbs.toFixed(2)}`);
}

// ---------- 2) WDF Crybaby(直接跑 crybabyStage,4x 过采样内部率) ----------
function runWdf(): void {
  const OS = 4;
  const stage = new CrybabyStage({ fs: FS * OS });
  let nanAt = -1, maxAbs = 0, zeroRun = 0, maxZeroRun = 0;
  let lastLog = 0;
  for (let i = 0; i < N; i++) {
    const w = sweptPosition(i) / 100;
    stage.setPosition(0.02 + 0.92 * Math.pow(w, 0.45));
    let y = 0;
    for (let k = 0; k < OS; k++) y = stage.process(k === 0 ? input[i] : 0);
    if (Number.isNaN(y) || !Number.isFinite(y)) {
      nanAt = i;
      const s = stage as unknown as Record<string, unknown>;
      console.log(`  NaN 现场: i=${i} u=${JSON.stringify(s.u)} vinPrev=${s.vinPrev} voutPrev=${s.voutPrev}`);
      console.log(`  vCinPrev=${s.vCinPrev} iCinPrev=${s.iCinPrev} vCplPrev=${s.vCplPrev} iCplPrev=${s.iCplPrev}`);
      console.log(`  vC2Prev=${s.vC2Prev} iC2Prev=${s.iC2Prev} vC3Prev=${s.vC3Prev} iC3Prev=${s.iC3Prev}`);
      console.log(`  lIhPrev=${s.lIhPrev} blkX=${s.blkX} blkY=${s.blkY} nonConverged=${s.nonConverged}`);
      break;
    }
    maxAbs = Math.max(maxAbs, Math.abs(y));
    zeroRun = Math.abs(y) < 1e-6 ? zeroRun + 1 : 0;
    maxZeroRun = Math.max(maxZeroRun, zeroRun);
    if (i - lastLog >= FS * 4) {
      lastLog = i;
      console.log(`  t=${(i / FS).toFixed(0)}s w=${w.toFixed(2)} y=${y.toFixed(5)} nonConverged=${stage.nonConverged} avgIters=${(stage.iterTotal / Math.max(1, stage.iterCount)).toFixed(1)}`);
    }
  }
  console.log(
    nanAt >= 0
      ? `  ✗ WDF 在 t=${(nanAt / FS).toFixed(2)}s 输出 NaN/Inf`
      : `  ${maxZeroRun > FS ? `✗ WDF 出现 ${(maxZeroRun / FS).toFixed(1)}s 连续零输出(死寂)` : `✓ WDF 20s 稳定`},maxAbs=${maxAbs.toFixed(3)},nonConverged=${stage.nonConverged}`,
  );
}

// ---------- 3) WDF 恶劣工况:热信号(类过载后方波 ±2V)+ 位置随机跳变 ----------
function runWdfHarsh(): void {
  const OS = 4;
  const stage = new CrybabyStage({ fs: FS * OS });
  let pos = 0.5;
  let nanAt = -1, maxAbs = 0;
  let constRun = 0, maxConstRun = 0;
  let lastY = 0;
  for (let i = 0; i < N; i++) {
    // 每 ~50ms 位置随机跳变(模拟 CC 步进),含极端位
    if (i % 2400 === 0) pos = Math.random();
    stage.setPosition(0.02 + 0.92 * Math.pow(pos, 0.45));
    const t = i / FS;
    // 过载后信号:削顶方波化,振幅 2V
    const raw = 2.0 * Math.tanh(3 * Math.sin(2 * Math.PI * 220 * t) + 1.5 * Math.sin(2 * Math.PI * 440 * t));
    let y = 0;
    for (let k = 0; k < OS; k++) y = stage.process(k === 0 ? raw : 0);
    if (Number.isNaN(y) || !Number.isFinite(y)) { nanAt = i; break; }
    maxAbs = Math.max(maxAbs, Math.abs(y));
    constRun = Math.abs(y - lastY) < 1e-9 ? constRun + 1 : 0;
    lastY = y;
    maxConstRun = Math.max(maxConstRun, constRun);
  }
  console.log(
    nanAt >= 0
      ? `  ✗ NaN/Inf @ t=${(nanAt / FS).toFixed(2)}s`
      : `  maxAbs=${maxAbs.toFixed(2)} nonConverged=${stage.nonConverged} 最长恒定输出=${(maxConstRun / FS).toFixed(2)}s ` +
        (maxConstRun > FS * 2 ? '✗ 疑似冻结(>2s 恒定)' : maxConstRun > FS * 0.2 ? '⚠ 有亚秒级冻结' : '✓ 无冻结'),
  );
}

console.log('== 1) crybaby-wah 谐振器 ==');
runResonator();
console.log('== 2) WDF Crybaby 常规扫频 ==');
runWdf();
console.log('== 3) WDF 恶劣工况 ==');
runWdfHarsh();
