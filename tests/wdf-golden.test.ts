import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  FS,
  SIGNALS,
  assertBitEqual,
  extractAssembledProcessor,
  makeSignal,
  readFixture,
  runBlocks,
  type BlockProcessor,
} from './helpers/wdf-golden.ts';
import { buildProcessorSource } from '../src/audio/workletLoader.ts';

/**
 * WDF 黄金样本回归(issue #7,ADR-0003):迁移前从 worklet 内联字符串
 * (用户实际听到的代码)录制的输出(tests/fixtures/wdf/,脉冲/扫频/白噪声,
 * descriptor 默认参数),迁移后两条路径都必须逐位一致:
 *
 *   1. engine 层 —— 直接 import *.dsp.js 的引擎类(node 环境,不经 ?raw)。
 *      这也是 worklet DSP 首次可 import 进 node:test 的证明,后续行为 pin
 *      (NaN 防御、参数边界)直接钉在引擎 export 上。
 *   2. 装配层 —— 按 worklet 文件的 ?raw import 列表 + wrapper 模板,用
 *      buildProcessorSource 重建实际发给 AudioWorklet 的完整字符串,
 *      在 shim 中实例化运行。
 *
 * fixtures 由 scripts/wdf-golden-record.ts 录制(迁移前)。
 */

interface GoldenEntry {
  /** fixture 前缀 / worklet 文件基名 */
  name: string;
  /** DSP 核模块(src/audio/wdf/ 下) */
  module: string;
  /** 引擎导出名(约定:new Engine(sampleRate) + process(inputs, outputs, params)) */
  engine: string;
}

const ENTRIES: GoldenEntry[] = [
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

const FIXTURE_DIR = 'tests/fixtures/wdf';

interface Manifest {
  effects: Record<string, { params: Record<string, number> }>;
}
const manifest = JSON.parse(
  readFileSync(`${FIXTURE_DIR}/manifest.json`, 'utf-8'),
) as Manifest;

function manifestParams(name: string): Record<string, number[]> {
  const params: Record<string, number[]> = {};
  for (const [k, v] of Object.entries(manifest.effects[name].params)) params[k] = [v];
  return params;
}

type EngineCtor = new (sampleRate: number) => BlockProcessor;

for (const entry of ENTRIES) {
  test(`wdf-golden[${entry.name}]: *.dsp.js 引擎输出与黄金样本逐位一致`, async () => {
    const mod = (await import(`../src/audio/wdf/${entry.module}`)) as Record<
      string,
      EngineCtor
    >;
    const Engine = mod[entry.engine];
    if (!Engine) throw new Error(`${entry.module} 未导出 ${entry.engine}`);
    const params = manifestParams(entry.name);
    for (const sig of SIGNALS) {
      const y = runBlocks(new Engine(FS), makeSignal(sig), params);
      assertBitEqual(
        y,
        readFixture(`${FIXTURE_DIR}/${entry.name}-${sig}.f32`),
        `${entry.name}/${sig}`,
      );
    }
  });

  test(`wdf-golden[${entry.name}]: worklet ?raw 装配串输出与黄金样本逐位一致`, () => {
    const { ctor, params } = extractAssembledProcessor(
      `src/audio/wdf/${entry.name}Worklet.ts`,
      buildProcessorSource,
    );
    for (const sig of SIGNALS) {
      const y = runBlocks(new ctor(), makeSignal(sig), params);
      assertBitEqual(
        y,
        readFixture(`${FIXTURE_DIR}/${entry.name}-${sig}.f32`),
        `${entry.name}/${sig} (装配)`,
      );
    }
  });
}
