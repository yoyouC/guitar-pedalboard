import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  FS,
  SIGNALS,
  GOLDEN_ENTRIES,
  assertGoldenEqual,
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
 * fixtures 由 scripts/wdf-golden-record.ts 录制;效果清单见
 * tests/helpers/wdf-golden.ts 的 GOLDEN_ENTRIES(唯一一份)。
 */

const FIXTURE_DIR = 'tests/fixtures/wdf';

test('golden comparison accepts CPU rounding but rejects material drift', () => {
  const value = new Float32Array([0.25]);
  const cpuRounding = new Float32Array([0.25000009]);
  const materialDrift = new Float32Array([0.250001]);

  assert.doesNotThrow(() => assertGoldenEqual(cpuRounding, value, 'CPU rounding'));
  assert.throws(
    () => assertGoldenEqual(materialDrift, value, 'material drift'),
    /绝对差/,
  );
  assert.throws(
    () => assertGoldenEqual(new Float32Array([-0]), new Float32Array([0]), 'signed zero'),
    /绝对差/,
  );
});

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

for (const entry of GOLDEN_ENTRIES) {
  test(`wdf-golden[${entry.name}]: *.dsp.js 引擎输出匹配黄金样本`, async () => {
    const mod = (await import(`../src/audio/wdf/${entry.module}`)) as Record<
      string,
      EngineCtor
    >;
    const Engine = mod[entry.engine];
    if (!Engine) throw new Error(`${entry.module} 未导出 ${entry.engine}`);
    const params = manifestParams(entry.name);
    for (const sig of SIGNALS) {
      const y = runBlocks(new Engine(FS), makeSignal(sig), params);
      assertGoldenEqual(
        y,
        readFixture(`${FIXTURE_DIR}/${entry.name}-${sig}.f32`),
        `${entry.name}/${sig}`,
      );
    }
  });

  test(`wdf-golden[${entry.name}]: worklet ?raw 装配串输出匹配黄金样本`, () => {
    const { ctor, params } = extractAssembledProcessor(
      `src/audio/wdf/${entry.name}Worklet.ts`,
      buildProcessorSource,
    );
    for (const sig of SIGNALS) {
      const y = runBlocks(new ctor(), makeSignal(sig), params);
      assertGoldenEqual(
        y,
        readFixture(`${FIXTURE_DIR}/${entry.name}-${sig}.f32`),
        `${entry.name}/${sig} (装配)`,
      );
    }
  });
}
