/**
 * 录制 WDF 黄金样本 fixtures(issue #7,ADR-0003)——迁移前运行一次:
 *
 *   node scripts/wdf-golden-record.ts
 *
 * 从 21 个 *Worklet.ts 提取当前内联 processorSource(用户实际听到的代码),
 * 在 shim 中以 descriptor 默认参数灌三种固定输入(脉冲/扫频/白噪声),
 * 输出存为 tests/fixtures/wdf/<effect>-<signal>.f32 + manifest.json。
 * 迁移后 tests/wdf-golden.test.ts 以同一 harness 驱动 *.dsp.js 引擎逐位断言。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  FS,
  N,
  BLOCK,
  SIGNALS,
  GOLDEN_ENTRIES,
  assertAllFinite,
  extractAssembledProcessor,
  extractInlineProcessor,
  makeSignal,
  runBlocks,
  writeFixture,
  type BlockProcessor,
} from '../tests/helpers/wdf-golden.ts';
import { buildProcessorSource } from '../src/audio/workletLoader.ts';

/** 迁移前的 worklet 是内联串;迁移后是 ?raw 装配。两种形态都能录。 */
function extractCurrentProcessor(workletPath: string): {
  ctor: new () => BlockProcessor;
  params: Record<string, number[]>;
} {
  try {
    return extractInlineProcessor(workletPath);
  } catch {
    return extractAssembledProcessor(workletPath, buildProcessorSource);
  }
}

const DIR = 'tests/fixtures/wdf';
mkdirSync(DIR, { recursive: true });

const manifest: Record<string, unknown> = {
  fs: FS,
  n: N,
  block: BLOCK,
  signals: SIGNALS,
  note: '迁移前从内联 processorSource 录制(scripts/wdf-golden-record.ts);参数为 descriptor 默认值',
  effects: {} as Record<string, unknown>,
};
const effects = manifest.effects as Record<string, unknown>;

for (const { name } of GOLDEN_ENTRIES) {
  const file = `${name}Worklet.ts`;
  const { ctor, params } = extractCurrentProcessor(`src/audio/wdf/${file}`);
  for (const sig of SIGNALS) {
    const proc = new ctor();
    const y = runBlocks(proc, makeSignal(sig), params);
    assertAllFinite(y, `${name}-${sig}`);
    writeFixture(`${DIR}/${name}-${sig}.f32`, y);
  }
  effects[name] = {
    worklet: `src/audio/wdf/${file}`,
    params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v[0]])),
  };
  console.log(`✓ ${name}`);
}

writeFileSync(`${DIR}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
console.log(`\n已录制 ${GOLDEN_ENTRIES.length} 个效果 × ${SIGNALS.length} 种信号 → ${DIR}/`);
