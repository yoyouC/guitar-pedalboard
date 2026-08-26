import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateRigLatency, WDF_4X_FIR_LATENCY } from '../src/audio/latency.ts';
import type { EffectDefinition } from '../src/audio/effects/types.ts';
import { Decimator4x, Upsampler4x, makeAntiAliasFIR } from '../src/audio/wdf/resample.dsp.js';
import { whammyEffect } from '../src/audio/effects/whammy.ts';
import { chorusEffect } from '../src/audio/effects/chorus.ts';
import { flangerEffect } from '../src/audio/effects/flanger.ts';

function def(id: string, processingSamples: number, designSamples: number): EffectDefinition {
  return {
    id,
    name: id,
    color: '#000',
    params: [],
    latency: { processingSamples, designSamples },
    create() {
      throw new Error('纯时延计算不得实例化 DSP');
    },
  };
}

test('Rig 链路按活动实际路径合成处理/设计时延', () => {
  const spec = {
    chain: [
      { uid: 'pre', def: def('pre', 12, 0), enabled: true, values: {}, post: false },
      { uid: 'off', def: def('off', 999, 999), enabled: false, values: {}, post: false },
      { uid: 'post', def: def('post', 0, 336), enabled: true, values: {}, post: true },
    ],
    amp: { def: def('amp', 4, 0), enabled: true, values: {} },
    cab: { def: def('cab', 0, 0), enabled: true, values: {} },
    globalBypass: false,
  };
  const result = calculateRigLatency(spec, 48_000);
  assert.equal(result.processingSamples, 16);
  assert.equal(result.designSamples, 336);
  assert.equal(result.totalMs, (352 / 48_000) * 1000);
  assert.deepEqual(result.items.map((item) => item.id), ['pre', 'post', 'amp:amp']);
});

test('globalBypass 的 Rig 链路时延为零', () => {
  const result = calculateRigLatency(
    {
      chain: [{ uid: 'p', def: def('p', 12, 0), enabled: true, values: {}, post: false }],
      amp: null,
      cab: null,
      globalBypass: true,
    },
    48_000,
  );
  assert.equal(result.totalMs, 0);
  assert.deepEqual(result.items, []);
});

test('WDF 4x FIR 元数据与真实单位脉冲峰值一致（±1 sample）', () => {
  const coefficients = makeAntiAliasFIR();
  const upsampler = new Upsampler4x(coefficients);
  const decimator = new Decimator4x(coefficients);
  const oversampled = new Float32Array(4);
  const output: number[] = [];
  for (let index = 0; index < 64; index++) {
    upsampler.process(oversampled, index === 0 ? 1 : 0);
    output.push(decimator.process(oversampled[0], oversampled[1], oversampled[2], oversampled[3]));
  }
  const peak = output.reduce(
    (best, value, index) => Math.abs(value) > Math.abs(output[best]) ? index : best,
    0,
  );
  assert.ok(Math.abs(peak - WDF_4X_FIR_LATENCY.processingSamples) <= 1, `peak=${peak}`);
});

test('Whammy 将音乐性移调窗标为设计时延', () => {
  const result = calculateRigLatency({
    chain: [{ uid: 'whammy', def: whammyEffect, enabled: true, values: { position: 50, range: 2 }, post: false }],
    amp: null,
    cab: null,
    globalBypass: false,
  }, 48_000);
  assert.equal(result.processingSamples, 0);
  assert.equal(result.designSamples, 336);
  assert.equal(result.designMs, 7);
});

test('干湿并联调制只在纯湿路径报告设计时延', () => {
  const calculate = (def: EffectDefinition, values: Record<string, number>) => calculateRigLatency({
    chain: [{ uid: def.id, def, enabled: true, values, post: false }],
    amp: null,
    cab: null,
    globalBypass: false,
  }, 48_000);
  assert.equal(calculate(chorusEffect, { mix: 50, depth: 50 }).designSamples, 0);
  assert.equal(calculate(chorusEffect, { mix: 100, depth: 50 }).designSamples, 840);
  assert.equal(calculate(flangerEffect, { mix: 50, depth: 60 }).designSamples, 0);
  assert.equal(calculate(flangerEffect, { mix: 100, depth: 60 }).designSamples, 86);
});
