import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import {
  createStubAudioContext,
  StubAudioWorkletNode,
  type StubGainNode,
} from './helpers/stub-audio-context.ts';
import type { EffectDefinition } from '../src/audio/effects/types.ts';
import { dbToGain, levelDbToGain } from '../src/audio/level.ts';
import { noiseGateEffect } from '../src/audio/effects/noiseGate.ts';
import { analogDelayEffect } from '../src/audio/effects/analogdelay.ts';
import { bigmuffWdfEffect } from '../src/audio/effects/bigmuffwdf.ts';
import { crybabyWdfEffect } from '../src/audio/effects/crybabywdf.ts';
import { ds1WdfEffect } from '../src/audio/effects/ds1wdf.ts';
import { dynaCompEffect } from '../src/audio/effects/dynacomp.ts';
import { fet1176Effect } from '../src/audio/effects/fet1176.ts';
import { fuzzfaceWdfEffect } from '../src/audio/effects/fuzzfacewdf.ts';
import { klonWdfEffect } from '../src/audio/effects/klonwdf.ts';
import { la2aEffect } from '../src/audio/effects/la2a.ts';
import { pingpongEffect } from '../src/audio/effects/pingpong.ts';
import { plateEffect } from '../src/audio/effects/plate.ts';
import { ratWdfEffect } from '../src/audio/effects/ratwdf.ts';
import { shimmerEffect } from '../src/audio/effects/shimmer.ts';
import { springReverbEffect } from '../src/audio/effects/springreverb.ts';
import { tapeDelayEffect } from '../src/audio/effects/tapedelay.ts';
import { ts808WdfEffect } from '../src/audio/effects/ts808wdf.ts';

/**
 * 直通 worklet 效果的行为 pin(issue #4):经 EffectDefinition 接口钉死今日行为——
 * create 接线(input → worklet(构造名)→ output)、初始参数同步、update 的
 * 键→参数映射(含 level 的 dB 换算与 crybaby 行程锥度)、构造失败兜底直通、
 * 两种 dispose 变体。数据化工厂迁移后必须原样通过。
 *
 * wahpedal/whammy 不在此列:它们有额外结构(兜底带通链 / 双键合成),
 * 不采用数据化工厂,保持手写。
 */

interface UpdateCase {
  /** UI 键 */
  key: string;
  /** 期望到达的 worklet 参数名 */
  param: string;
  /** update 入参 */
  value: number;
  /** 期望到达参数的值(已经过映射) */
  expected: number;
}

interface EffectPin {
  label: string;
  effect: EffectDefinition;
  processor: string;
  workletOptions?: Record<string, unknown>;
  smoothing?: number;
  suspend?: boolean;
  initParams?: Record<string, number>;
  outputGain?: number;
  cases: UpdateCase[];
}

/** level(dB)键的公共用例 */
const LEVEL_CASE: UpdateCase = { key: 'level', param: 'level', value: -12, expected: levelDbToGain(-12) };
const LEVEL_INIT = { level: 1 };

const PINS: EffectPin[] = [
  {
    label: 'noiseGate',
    effect: noiseGateEffect,
    processor: 'noise-gate',
    smoothing: 0.02,
    suspend: true,
    cases: [{ key: 'threshold', param: 'threshold', value: -60, expected: -60 }],
  },
  {
    label: 'analogdelay',
    effect: analogDelayEffect,
    processor: 'bbd-analog-delay', // 离群构造名,原样保留
    cases: [{ key: 'time', param: 'time', value: 300, expected: 300 }],
  },
  {
    label: 'bigmuffwdf',
    effect: bigmuffWdfEffect,
    processor: 'wdf-bigmuff',
    initParams: LEVEL_INIT,
    cases: [{ key: 'sustain', param: 'sustain', value: 80, expected: 80 }, LEVEL_CASE],
  },
  {
    label: 'crybabywdf',
    effect: crybabyWdfEffect,
    processor: 'wdf-crybaby',
    suspend: true,
    initParams: LEVEL_INIT,
    outputGain: 0.8,
    cases: [
      {
        key: 'position',
        param: 'position',
        value: 75,
        // 行程锥度:0.02 + 0.92·u^0.45,归一到 0~100
        expected: (0.02 + 0.92 * Math.pow(0.75, 0.45)) * 100,
      },
      LEVEL_CASE,
    ],
  },
  {
    label: 'ds1wdf',
    effect: ds1WdfEffect,
    processor: 'wdf-ds1',
    initParams: LEVEL_INIT,
    cases: [{ key: 'dist', param: 'dist', value: 70, expected: 70 }, LEVEL_CASE],
  },
  {
    label: 'dynacomp',
    effect: dynaCompEffect,
    processor: 'wdf-dynacomp',
    initParams: LEVEL_INIT,
    cases: [{ key: 'sensitivity', param: 'sensitivity', value: 60, expected: 60 }, LEVEL_CASE],
  },
  {
    label: 'fet1176',
    effect: fet1176Effect,
    processor: 'wdf-fet1176',
    initParams: LEVEL_INIT,
    cases: [{ key: 'ratio', param: 'ratio', value: 8, expected: 8 }, LEVEL_CASE],
  },
  {
    label: 'fuzzfacewdf',
    effect: fuzzfaceWdfEffect,
    processor: 'wdf-fuzzface',
    initParams: LEVEL_INIT,
    cases: [{ key: 'fuzz', param: 'fuzz', value: 90, expected: 90 }, LEVEL_CASE],
  },
  {
    label: 'klonwdf',
    effect: klonWdfEffect,
    processor: 'wdf-klon',
    initParams: LEVEL_INIT,
    cases: [{ key: 'gain', param: 'gain', value: 65, expected: 65 }, LEVEL_CASE],
  },
  {
    label: 'la2a',
    effect: la2aEffect,
    processor: 'opto-la2a',
    initParams: { gain: 1 },
    cases: [
      { key: 'reduction', param: 'reduction', value: 50, expected: 50 },
      { key: 'gain', param: 'gain', value: 10, expected: dbToGain(10) },
    ],
  },
  {
    label: 'pingpong',
    effect: pingpongEffect,
    processor: 'pingpong-delay',
    workletOptions: { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] },
    cases: [{ key: 'time', param: 'time', value: 500, expected: 500 }],
  },
  {
    label: 'plate',
    effect: plateEffect,
    processor: 'plate-reverb',
    cases: [{ key: 'damp', param: 'damp', value: 40, expected: 40 }],
  },
  {
    label: 'ratwdf',
    effect: ratWdfEffect,
    processor: 'wdf-rat',
    initParams: LEVEL_INIT,
    cases: [{ key: 'drive', param: 'drive', value: 85, expected: 85 }, LEVEL_CASE],
  },
  {
    label: 'shimmer',
    effect: shimmerEffect,
    processor: 'wdf-shimmer',
    cases: [{ key: 'shimmer', param: 'shimmer', value: 60, expected: 60 }],
  },
  {
    label: 'springreverb',
    effect: springReverbEffect,
    processor: 'wdf-springreverb',
    cases: [{ key: 'dwell', param: 'dwell', value: 70, expected: 70 }],
  },
  {
    label: 'tapedelay',
    effect: tapeDelayEffect,
    processor: 'wdf-tapedelay',
    cases: [{ key: 'feedback', param: 'feedback', value: 60, expected: 60 }],
  },
  {
    label: 'ts808wdf',
    effect: ts808WdfEffect,
    processor: 'wdf-ts808',
    initParams: LEVEL_INIT,
    cases: [{ key: 'drive', param: 'drive', value: 75, expected: 75 }, LEVEL_CASE],
  },
];

for (const pin of PINS) {
  test(`worklet 效果 pin[${pin.label}]:create 接线/初始同步/update 映射/dispose 变体`, () => {
    mock.method(console, 'warn', () => {});
    const smoothing = pin.smoothing ?? 0.03;

    // ---- create:接线、构造名、options、初始同步 ----
    const ctx = createStubAudioContext();
    const inst = pin.effect.create(ctx as unknown as AudioContext);
    const input = inst.input as unknown as StubGainNode;
    const output = inst.output as unknown as StubGainNode;

    const worklets = ctx.nodesOfKind<StubAudioWorkletNode>('AudioWorkletNode');
    assert.equal(worklets.length, 1, `${pin.label}: 应恰好一个 worklet 节点`);
    const node = worklets[0];
    assert.equal(node.processorName, pin.processor, `${pin.label}: 处理器构造名`);
    if (pin.workletOptions) assert.deepEqual(node.options, pin.workletOptions);
    assert.ok(ctx.isConnected(input, node), `${pin.label}: input → worklet`);
    assert.ok(ctx.isConnected(node, output), `${pin.label}: worklet → output`);
    if (pin.outputGain !== undefined) {
      assert.equal(output.gain.value, pin.outputGain, `${pin.label}: 输出级增益`);
    }
    for (const [k, v] of Object.entries(pin.initParams ?? {})) {
      const calls = node.parameters.get(k)?.callsOf('setValueAtTime');
      assert.deepEqual(calls?.at(-1)?.args, [v, 0], `${pin.label}: 初始同步 ${k}`);
    }

    // ---- update:键 → (参数名, 映射值),setTargetAtTime(x, t, smoothing) ----
    for (const c of pin.cases) {
      inst.update(c.key, c.value);
      const calls = node.parameters.get(c.param)?.callsOf('setTargetAtTime');
      assert.deepEqual(
        calls?.at(-1)?.args,
        [c.expected, 0, smoothing],
        `${pin.label}: update('${c.key}') → ${c.param}`,
      );
    }

    // ---- dispose:两种变体 ----
    inst.dispose();
    const disconnectOrder = ctx.connectionLog
      .filter((e) => e.type === 'disconnect')
      .map((e) => e.from);
    if (pin.suspend) {
      assert.deepEqual(node.port.messages, [{ type: 'suspend' }], `${pin.label}: suspend 消息`);
      assert.equal(node.port.onmessage, null, `${pin.label}: port.onmessage 清空`);
      assert.deepEqual(disconnectOrder, [input, output, node], `${pin.label}: dispose 断开顺序`);
    } else {
      assert.deepEqual(node.port.messages, [], `${pin.label}: 无 suspend 消息`);
      assert.deepEqual(disconnectOrder, [input, node, output], `${pin.label}: dispose 断开顺序`);
    }
    assert.equal(ctx.connections.length, 0, `${pin.label}: dispose 后无存活连接`);

    // ---- worklet 构造失败:兜底直通 ----
    const ctx2 = createStubAudioContext();
    class ThrowingWorkletNode {
      constructor() {
        throw new Error('processor 未注册');
      }
    }
    (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode = ThrowingWorkletNode;
    const inst2 = pin.effect.create(ctx2 as unknown as AudioContext);
    const input2 = inst2.input as unknown as StubGainNode;
    const output2 = inst2.output as unknown as StubGainNode;
    assert.equal(ctx2.nodesOfKind('AudioWorkletNode').length, 0, `${pin.label}: 兜底不建 worklet`);
    assert.ok(ctx2.isConnected(input2, output2), `${pin.label}: 兜底 input → output 直通`);
    inst2.dispose();
  });
}
