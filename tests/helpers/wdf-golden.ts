/**
 * WDF 黄金样本共享 harness(issue #7,ADR-0003)。
 *
 * 录制(scripts/wdf-golden-record.ts,迁移前)与断言(tests/wdf-golden.test.ts,
 * 迁移后)共用同一套信号生成与块率驱动,保证两条路径跑的是同一份数值代码:
 *   - 录制侧:readFileSync 提取 worklet 内联 processorSource,在 shim 中实例化
 *     (scripts/whammy-eval.ts 已验证的手法);
 *   - 断言侧:直接 import *.dsp.js 的 Engine 类(node 环境,不经 ?raw)。
 * 两侧都以相同的输入信号、参数(内联 descriptor 默认值)、块大小驱动,
 * 输出逐位对比。
 */
import { readFileSync, writeFileSync } from 'node:fs';

export const FS = 48000;
export const BLOCK = 128;
export const N = 4096;

export const SIGNALS = ['impulse', 'sweep', 'noise'] as const;
export type SignalName = (typeof SIGNALS)[number];

/**
 * 21 个 WDF 效果的契约表(唯一一份,录制与断言共用):
 * name 同时是 fixture 前缀与 worklet 文件名(<name>Worklet.ts);
 * module/engine 是 *.dsp.js 与其引擎导出名(构造注入 sampleRate,
 * process(inputs, outputs, params) 语义同 AudioWorkletProcessor)。
 */
export interface GoldenEntry {
  name: string;
  module: string;
  engine: string;
}

export const GOLDEN_ENTRIES: GoldenEntry[] = [
  { name: 'champ', module: 'champ.dsp.js', engine: 'WdfChampEngine' },
  { name: 'bogner', module: 'bogner.dsp.js', engine: 'WdfBognerEngine' },
  { name: 'twin', module: 'twinStages.dsp.js', engine: 'WdfTwinEngine' },
  { name: 'ac30', module: 'ac30Core.dsp.js', engine: 'WdfAc30Engine' },
  { name: 'jc120', module: 'jc120Core.dsp.js', engine: 'WdfJc120Engine' },
  { name: 'ts808', module: 'diodeClipper.dsp.js', engine: 'WdfTs808Engine' },
  { name: 'ds1', module: 'ds1Clipper.dsp.js', engine: 'WdfDs1Engine' },
  { name: 'rat', module: 'ratDistortion.dsp.js', engine: 'WdfRatEngine' },
  { name: 'bigmuff', module: 'bigmuff.dsp.js', engine: 'WdfBigMuffEngine' },
  { name: 'fuzzface', module: 'fuzzFaceStage.dsp.js', engine: 'WdfFuzzFaceEngine' },
  { name: 'crybaby', module: 'crybabyStage.dsp.js', engine: 'WdfCrybabyEngine' },
  { name: 'klon', module: 'klonCentaur.dsp.js', engine: 'WdfKlonEngine' },
  { name: 'fet1176', module: 'fetComp.dsp.js', engine: 'WdfFet1176Engine' },
  { name: 'la2a', module: 'la2aOpto.dsp.js', engine: 'La2aOptoEngine' },
  { name: 'dynacomp', module: 'dynaComp.dsp.js', engine: 'WdfDynaCompEngine' },
  { name: 'analogdelay', module: 'analogDelay.dsp.js', engine: 'BbdAnalogDelayEngine' },
  { name: 'tapedelay', module: 'tapeDelay.dsp.js', engine: 'WdfTapeDelayEngine' },
  { name: 'pingpong', module: 'pingPongDelay.dsp.js', engine: 'PingPongDelayEngine' },
  { name: 'springreverb', module: 'springReverb.dsp.js', engine: 'WdfSpringReverbEngine' },
  { name: 'plate', module: 'plateReverb.dsp.js', engine: 'PlateReverbEngine' },
  { name: 'shimmer', module: 'shimmerReverb.dsp.js', engine: 'WdfShimmerEngine' },
];

/** mulberry32 定种子 PRNG,噪声信号可复现 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 固定输入信号:脉冲 / 对数扫频(20Hz→15kHz,幅 0.3)/ 白噪声(±0.3,种子 42) */
export function makeSignal(kind: SignalName, n: number = N): Float32Array {
  const x = new Float32Array(n);
  if (kind === 'impulse') {
    x[0] = 0.5;
  } else if (kind === 'sweep') {
    const f0 = 20;
    const f1 = 15000;
    const T = n / FS;
    const k = Math.log(f1 / f0);
    for (let i = 0; i < n; i++) {
      const t = i / FS;
      const phase = ((2 * Math.PI * f0 * T) / k) * (Math.exp((k * t) / T) - 1);
      x[i] = 0.3 * Math.sin(phase);
    }
  } else {
    const rand = mulberry32(42);
    for (let i = 0; i < n; i++) x[i] = 0.3 * (2 * rand() - 1);
  }
  return x;
}

/** 可被块率驱动的对象:迁移前的内联处理器实例,或迁移后的 *.dsp.js Engine 实例 */
export interface BlockProcessor {
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    params: Record<string, number[]>,
  ): boolean;
}

/** 以 AudioWorklet 块语义驱动:128 采样/块,单声道进单声道出 */
export function runBlocks(
  proc: BlockProcessor,
  input: Float32Array,
  params: Record<string, number[]>,
): Float32Array {
  const out = new Float32Array(input.length);
  const inBuf = new Float32Array(BLOCK);
  const outBuf = new Float32Array(BLOCK);
  for (let off = 0; off < input.length; off += BLOCK) {
    inBuf.fill(0);
    outBuf.fill(0);
    inBuf.set(input.subarray(off, Math.min(off + BLOCK, input.length)));
    proc.process([[inBuf]], [[outBuf]], params);
    out.set(outBuf.subarray(0, Math.min(BLOCK, input.length - off)), off);
  }
  return out;
}

interface ProcessorCtor {
  new (): BlockProcessor;
  readonly parameterDescriptors: { name: string; defaultValue: number }[];
}

/**
 * 在 shim AudioWorklet 环境中执行一段处理器源码(完整 IIFE),
 * 返回注册到的处理器构造函数与 descriptor 默认参数(k-rate 形态:单元素数组)。
 */
export function instantiateProcessorSource(source: string, label: string): {
  ctor: ProcessorCtor;
  params: Record<string, number[]>;
} {
  let captured: ProcessorCtor | null = null;
  class ShimAudioWorkletProcessor {
    port: { onmessage: unknown } = { onmessage: null };
  }
  const registerProcessor = (_name: string, ctor: ProcessorCtor): void => {
    captured = ctor;
  };
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', source)(
    ShimAudioWorkletProcessor,
    registerProcessor,
    FS,
  );
  if (!captured) throw new Error(`处理器未注册: ${label}`);
  const ctor: ProcessorCtor = captured;
  const params: Record<string, number[]> = {};
  for (const d of ctor.parameterDescriptors) params[d.name] = [d.defaultValue];
  return { ctor, params };
}

/**
 * 从 worklet 文件提取内联 processorSource 并在 shim 中实例化。
 * (迁移前录制用;迁移后 worklet 改为 ?raw 装配,见 extractAssembledProcessor。)
 */
export function extractInlineProcessor(workletPath: string): {
  ctor: ProcessorCtor;
  params: Record<string, number[]>;
} {
  const src = readFileSync(workletPath, 'utf-8');
  const m = src.match(/const processorSource = `([\s\S]*?)`;/);
  if (!m) throw new Error(`processorSource 提取失败: ${workletPath}`);
  return instantiateProcessorSource(m[1], workletPath);
}

/**
 * 迁移后:按 worklet 文件的 ?raw import 列表与 wrapper 模板,重建运行时
 * processorSource(与 buildProcessorSource 同一函数),在 shim 中实例化。
 * 这验证的就是实际发给 AudioWorklet 的那段字符串。
 *
 * 格式契约(脆弱点,改 worklet 文件时注意):依赖 worklet 保持
 * `import xSource from './foo.dsp.js?raw';`(单引号、单行)与
 * `buildProcessorSource([...], \`wrapper\`)`(wrapper 为无插值模板字面量)
 * 的写法;偏离任一写法这里会抛提取失败。
 */
export function extractAssembledProcessor(
  workletPath: string,
  build: (dspSources: string[], wrapper: string) => string,
): {
  ctor: ProcessorCtor;
  params: Record<string, number[]>;
} {
  const src = readFileSync(workletPath, 'utf-8');
  const dspFiles = [...src.matchAll(/import \w+ from '\.\/([\w.-]+\.dsp\.js)\?raw';/g)].map(
    (m) => m[1],
  );
  if (!dspFiles.length) throw new Error(`?raw import 提取失败: ${workletPath}`);
  const wm = src.match(/buildProcessorSource\(\s*\[[^\]]*\],\s*`([\s\S]*?)`,\s*\)/);
  if (!wm) throw new Error(`wrapper 模板提取失败: ${workletPath}`);
  const dir = workletPath.replace(/[^/]+$/, '');
  const dspSources = dspFiles.map((f) => readFileSync(dir + f, 'utf-8'));
  return instantiateProcessorSource(build(dspSources, wm[1]), workletPath);
}

const GOLDEN_ABSOLUTE_TOLERANCE = 1e-7;
const GOLDEN_RELATIVE_TOLERANCE = 1e-6;

/**
 * Float32 golden 断言。相同平台仍逐位一致；跨 CPU 允许低于 -120 dB 的舍入差异，
 * 同时继续区分 -0、NaN、Infinity 和真正的 DSP 数值漂移。
 */
export function assertGoldenEqual(
  actual: Float32Array,
  expected: Float32Array,
  label: string,
): void {
  if (actual.length !== expected.length) {
    throw new Error(`${label}: 长度不一致 ${actual.length} vs ${expected.length}`);
  }
  for (let i = 0; i < actual.length; i++) {
    if (Object.is(actual[i], expected[i])) continue;
    const difference = Math.abs(actual[i] - expected[i]);
    const tolerance = Math.max(
      GOLDEN_ABSOLUTE_TOLERANCE,
      Math.abs(expected[i]) * GOLDEN_RELATIVE_TOLERANCE,
    );
    const invalid = !Number.isFinite(actual[i])
      || !Number.isFinite(expected[i])
      || (actual[i] === 0 && expected[i] === 0);
    if (invalid || difference > tolerance) {
      throw new Error(
        `${label}: 样本 ${i} 起分叉 ${actual[i]} vs ${expected[i]} `
        + `(绝对差 ${difference}, 容差 ${tolerance})`,
      );
    }
  }
}

/** Float32 二进制 fixture 读写(小端,所有目标平台一致) */
export function writeFixture(path: string, data: Float32Array): void {
  writeFileSync(path, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
}

export function readFixture(path: string): Float32Array {
  const b = readFileSync(path);
  // slice 出独立 ArrayBuffer,避免 Buffer 池的 byteOffset 不对齐 Float32Array
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

/** 输出全有限值检查(录制侧用,防止把 NaN 灌进 fixtures) */
export function assertAllFinite(data: Float32Array, label: string): void {
  for (let i = 0; i < data.length; i++) {
    if (!Number.isFinite(data[i])) {
      throw new Error(`${label}: 样本 ${i} 非有限值 (${data[i]})`);
    }
  }
}
