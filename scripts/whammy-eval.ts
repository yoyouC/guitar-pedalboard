/**
 * Whammy 移调单块自测(node scripts/whammy-eval.ts)
 * 从 whammyWorklet.ts 提取 processorSource 在 shim 中实例化,检查:
 *   1. 移调精度(+2/+1/-2 半音,过零计数测平均频率;算法固有颤音,容差 ±5%)
 *   2. 0 半音透明度(平直增益、固定延迟、无调制)
 *   3. 连续扫频有界无 NaN、无爆音
 *   4. 增益≈unity(补偿后 ±2dB)
 */
import { readFileSync } from 'node:fs';

const FS = 48000;
const BLOCK = 128;

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}: ${detail}`);
  if (!ok) failures++;
}

// ---------- 提取并实例化 worklet 处理器 ----------
const src = readFileSync('src/audio/whammyWorklet.ts', 'utf-8');
const m = src.match(/const processorSource = `([\s\S]*?)`;\n\nlet loaded/);
if (!m) {
  console.error('提取 processorSource 失败');
  process.exit(1);
}
let captured: unknown = null;
class ShimAWP {
  port: { onmessage: unknown } = { onmessage: null };
}
const registerProcessor = (_name: string, ctor: unknown) => {
  captured = ctor;
};
new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', m[1])(
  ShimAWP,
  registerProcessor,
  FS,
);
type Proc = {
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    params: Record<string, number[] | Float32Array>,
  ): boolean;
};
const Proc1 = captured as new () => Proc;

/** 跑 input 个采样,semitones 可为常量或逐样本函数,返回输出 */
function run(
  input: Float32Array,
  semitones: number | ((n: number) => number),
): Float32Array {
  const proc = new Proc1();
  const out = new Float32Array(input.length);
  for (let off = 0; off < input.length; off += BLOCK) {
    const inBuf = new Float32Array(BLOCK);
    const outBuf = new Float32Array(BLOCK);
    const stArr = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK && off + i < input.length; i++) {
      inBuf[i] = input[off + i];
      stArr[i] = typeof semitones === 'function' ? semitones(off + i) : semitones;
    }
    proc.process([[inBuf]], [[outBuf]], { semitones: stArr, level: [1] });
    out.set(outBuf.subarray(0, Math.min(BLOCK, input.length - off)), off);
  }
  return out;
}

function sine(freq: number, amp: number, n: number): Float32Array {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / FS);
  return x;
}

function goertzel(x: Float32Array, freq: number, start: number, len: number): number {
  const w = (2 * Math.PI * freq) / FS;
  let re = 0, im = 0;
  for (let i = start; i < start + len; i++) {
    re += x[i] * Math.cos(w * i);
    im -= x[i] * Math.sin(w * i);
  }
  return (2 * Math.hypot(re, im)) / len;
}

/** 过零计数测平均频率 */
function avgFreq(x: Float32Array, start: number, len: number): number {
  let crossings = 0;
  for (let i = start + 1; i < start + len; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) crossings++;
  }
  return (crossings * FS) / len;
}

function rms(x: Float32Array, start: number, len: number): number {
  let s = 0;
  for (let i = start; i < start + len; i++) s += x[i] * x[i];
  return Math.sqrt(s / len);
}

const SETTLE = Math.round(FS * 0.5);
const MEASURE = Math.round(FS * 1.0);
const N = SETTLE + MEASURE;

// ---------- 1. 移调精度 ----------
console.log('1. 移调精度(440Hz 输入,过零测平均频率,±5%)');
for (const [st, expect] of [
  [2, 493.9],
  [1, 466.2],
  [-2, 392.0],
] as const) {
  const y = run(sine(440, 0.3, N), st);
  const f = avgFreq(y, SETTLE, MEASURE);
  const errPct = ((f - expect) / expect) * 100;
  check(
    `${st > 0 ? '+' : ''}${st}st → ${expect}Hz`,
    Math.abs(errPct) <= 5,
    `${f.toFixed(1)}Hz(${errPct >= 0 ? '+' : ''}${errPct.toFixed(1)}%)`,
  );
}

// ---------- 2. 0 半音透明度 ----------
console.log('2. 0 半音透明度');
{
  const y = run(sine(440, 0.3, N), 0);
  const g440 = 20 * Math.log10(goertzel(y, 440, SETTLE, MEASURE) / 0.3);
  const y3 = run(sine(3000, 0.3, N), 0);
  const g3k = 20 * Math.log10(goertzel(y3, 3000, SETTLE, MEASURE) / 0.3);
  check('440Hz 增益 0±1dB', Math.abs(g440) <= 1, `${g440.toFixed(2)}dB`);
  check('3kHz 增益 0±1dB(平直、无梳状)', Math.abs(g3k) <= 1, `${g3k.toFixed(2)}dB`);
  // 固定延迟:与延迟 336 采样的输入逐样本一致(建立期后相位已归位 0.5)
  const x = sine(440, 0.3, N);
  let maxDiff = 0;
  for (let i = SETTLE + Math.round(FS * 0.1); i < N; i++) {
    maxDiff = Math.max(maxDiff, Math.abs(y[i] - x[i - 336]));
  }
  check('固定 7ms(336 采样)延迟、无调制', maxDiff < 0.01, `maxDiff=${maxDiff.toExponential(2)}`);
}

// ---------- 3. 扫频有界性/连续性 ----------
console.log('3. 摇杆连续扫动(-2st → +2st,50ms 斜坡)');
{
  const x = sine(330, 0.3, N);
  let nan = false, maxAbs = 0, maxJump = 0;
  const y = run(x, (n) => {
    const t = (n / FS) * 20;
    const tri = Math.abs((t % 2) - 1);
    return -2 + 4 * tri;
  });
  for (let i = SETTLE; i < N; i++) {
    if (Number.isNaN(y[i])) nan = true;
    maxAbs = Math.max(maxAbs, Math.abs(y[i]));
    maxJump = Math.max(maxJump, Math.abs(y[i] - y[i - 1]));
  }
  check('无 NaN', !nan, '');
  check('输出有界(<0.6)', maxAbs < 0.6, `maxAbs=${maxAbs.toFixed(3)}`);
  check('无爆音(样本跳变 <0.15)', maxJump < 0.15, `maxJump=${maxJump.toFixed(4)}`);
}

// ---------- 4. 增益(补偿后 ±2dB) ----------
console.log('4. 增益(RMS out/in,±2dB)');
for (const st of [-2, -1, 1, 2]) {
  const x = sine(440, 0.3, N);
  const y = run(x, st);
  const g = 20 * Math.log10(rms(y, SETTLE, MEASURE) / rms(x, SETTLE, MEASURE));
  check(`${st > 0 ? '+' : ''}${st}st`, Math.abs(g) <= 2, `${g.toFixed(2)}dB`);
}

console.log(failures ? `\n${failures} 项失败 ✗` : '\n全部通过 ✓');
process.exit(failures ? 1 : 0);
