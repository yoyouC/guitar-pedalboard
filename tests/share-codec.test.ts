import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeShareState, encodeShareState } from '../src/state/share.ts';
import { createDefaultPreAmpEqState } from '../src/audio/preAmpEq.ts';

/**
 * share decode 走 presetCodec 的 catalog normalize(ADR-0006):
 * 编码格式不变,但 clamp/校验语义与 preset 路径统一。
 * 测试用手工构造的 payload + node 自带 base64url(独立于应用编码器)。
 */

function encodePayload(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

test('decode: 字符串数字不被容忍,回退参数默认值(catalog 严格语义)', () => {
  // 旧实现用 Number() 强转,"50" 会被接受为 50;统一后非 number 回退默认。
  const encoded = encodePayload({
    v: 1,
    c: [{ id: 'dynacomp', e: 1, v: { sensitivity: '55', level: 3 }, p: 0 }],
    a: { cat: 'crunch', key: 'builtin:crunch', on: 1, v: { gain: '80' } },
    b: { id: 'gb4x12', on: 1, v: { level: -10 } },
  });
  const share = decodeShareState(encoded)!;
  assert.ok(share);
  const comp = share.chain[0];
  assert.equal(comp.effectId, 'dynacomp');
  // sensitivity 是字符串 → 默认值;level 是合法 number → 保留
  assert.notEqual(comp.values.sensitivity, 55);
  assert.equal(comp.values.level, 3);
  assert.equal(typeof comp.values.sensitivity, 'number');
  // 箱头 gain 是字符串 → 默认值(而非 80)
  assert.notEqual(share.ampValues.gain, 80);
});

test('decode: 越界数值钳制到定义范围(与应用内编码器 round-trip 一致)', () => {
  const encoded = encodePayload({
    v: 1,
    c: [{ id: 'dynacomp', e: 1, v: { sensitivity: 9999, level: -9999 }, p: 0 }],
    a: { cat: 'crunch', key: 'builtin:crunch', on: 1, v: { gain: 12345 } },
    b: { id: 'gb4x12', on: 1, v: { level: 999 } },
  });
  const share = decodeShareState(encoded)!;
  assert.equal(share.chain[0].values.sensitivity, 100);
  assert.equal(share.chain[0].values.level, -30);
  assert.equal(share.ampValues.gain, 100);
  assert.equal(share.cabValues.level, 6);
});

test('decode: 缺省箱体段 → 默认箱体带默认参数值(不再产出空 values)', () => {
  const encoded = encodePayload({
    v: 1,
    c: [],
    a: { cat: 'crunch', key: 'builtin:crunch', on: 1, v: {} },
  });
  const share = decodeShareState(encoded)!;
  assert.equal(share.cabId, 'gb4x12');
  assert.ok(Object.keys(share.cabValues).length > 0);
  assert.ok(Object.values(share.cabValues).every((v) => typeof v === 'number'));
});

test('decode: 未知效果跳过、未知型号回退目录默认箱头', () => {
  const encoded = encodePayload({
    v: 1,
    c: [
      { id: 'no-such-pedal', e: 1, v: {}, p: 0 },
      { id: 'dynacomp', e: 1, v: {}, p: 0 },
    ],
    a: { cat: 'zzz', key: 'no:such-model', on: 1, v: {} },
    b: { id: 'no-such-cab', on: 1, v: {} },
  });
  const share = decodeShareState(encoded)!;
  assert.deepEqual(
    share.chain.map((i) => i.effectId),
    ['dynacomp'],
  );
  assert.equal(share.ampModelKey, 'builtin:crunch');
  assert.equal(share.ampCategoryId, 'crunch');
  assert.equal(share.cabId, 'gb4x12');
});

test('decode: 缺省 post 字段时按效果器默认前后置归属', () => {
  const encoded = encodePayload({
    v: 1,
    c: [
      { id: 'dynacomp', e: 1, v: {} },
      { id: 'springreverb', e: 1, v: {} },
    ],
    a: { cat: 'crunch', key: 'builtin:crunch', on: 1, v: {} },
    b: { id: 'gb4x12', on: 1, v: {} },
  });
  const share = decodeShareState(encoded)!;
  assert.equal(share.chain[0].post, false);
  assert.equal(share.chain[1].post, true);
});

test('encode/decode round-trip 保持链、型号与参数', () => {
  const original = decodeShareState(
    encodePayload({
      v: 1,
      c: [{ id: 'klonwdf', e: 0, v: { gain: 22, treble: 50, level: -11.5 }, p: 1 }],
      a: { cat: 'crunch', key: 'nam-wasm-pack:jcm800-sweep', on: 1, v: { gain: 64 } },
      b: { id: 'gb4x12', on: 0, v: { level: -13.5 } },
    }),
  )!;
  const roundTripped = decodeShareState(encodeShareState(original))!;
  assert.deepEqual(
    roundTripped.chain.map(({ effectId, enabled, values, post }) => ({
      effectId,
      enabled,
      values,
      post,
    })),
    original.chain.map(({ effectId, enabled, values, post }) => ({
      effectId,
      enabled,
      values,
      post,
    })),
  );
  assert.equal(roundTripped.ampModelKey, original.ampModelKey);
  assert.equal(roundTripped.ampCategoryId, original.ampCategoryId);
  assert.equal(roundTripped.cabEnabled, original.cabEnabled);
  assert.deepEqual(roundTripped.preAmpEq, createDefaultPreAmpEqState());
});

test('legacy share v1-v3 缺少 EQ 时都迁移为 Bypass 全平', () => {
  for (const version of [1, 2, 3]) {
    const restored = decodeShareState(encodePayload({
      v: version,
      c: [],
      a: { cat: 'clean', key: 'builtin:clean', on: 1, v: {} },
      b: { id: 'gb4x12', on: 1, v: {} },
      q: { on: 1, b: { hz1000: 12 }, l: 12 },
    }))!;
    assert.deepEqual(restored.preAmpEq, createDefaultPreAmpEqState(), `v${version}`);
  }
});

test('current share round-trip keeps Tone3000 Pedal and Amp exact model variants', () => {
  const encoded = encodeShareState({
    chain: [{
      uid: 'cloud-pedal',
      effectId: 'tone3000Nam',
      modelRef: 'tone3000:42',
      modelId: '9001',
      enabled: true,
      values: { level: -3 },
      post: false,
    }],
    ampCategoryId: 'tone3000',
    ampModelKey: 'tone3000:77',
    ampModelId: '7007',
    ampEnabled: true,
    ampValues: { gain: 50 },
    cabId: 'gb4x12',
    cabEnabled: true,
    cabValues: { level: -6 },
    preAmpEq: createDefaultPreAmpEqState(),
  });
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  assert.equal(payload.v, 5);

  const restored = decodeShareState(encoded)!;
  assert.equal(restored.chain[0].modelRef, 'tone3000:42');
  assert.equal(restored.chain[0].modelId, '9001');
  assert.equal(restored.ampModelId, '7007');
});

test('current share preserves custom IR identity without binary data', () => {
  const hash = 'b'.repeat(64);
  const encoded = encodeShareState({
    chain: [],
    ampCategoryId: 'clean',
    ampModelKey: 'builtin:clean',
    ampEnabled: true,
    ampValues: {},
    cabId: 'customIr',
    cabIrRef: { kind: 'custom', hash },
    cabEnabled: true,
    cabValues: { level: -6 },
    preAmpEq: createDefaultPreAmpEqState(),
  });
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  assert.equal(payload.v, 5);
  assert.deepEqual(payload.b.r, { k: 'c', h: hash });
  assert.deepEqual(decodeShareState(encoded)?.cabIrRef, { kind: 'custom', hash });
});

test('v4 share round-trip preserves and clamps the named箱头前均衡 bands', () => {
  const encoded = encodePayload({
    v: 4,
    c: [],
    a: { cat: 'crunch', key: 'builtin:crunch', on: 1, v: {} },
    b: { id: 'gb4x12', on: 1, v: {} },
    q: { on: 1, b: { hz31_25: -99, hz1000: 4.5, hz16000: 99 }, l: -3 },
  });
  const restored = decodeShareState(encoded)!;
  assert.equal(restored.preAmpEq.enabled, true);
  assert.equal(restored.preAmpEq.bands.hz31_25, -12);
  assert.equal(restored.preAmpEq.bands.hz1000, 4.5);
  assert.equal(restored.preAmpEq.bands.hz16000, 12);
  assert.equal(restored.preAmpEq.levelDb, -3);
  assert.deepEqual(restored.preAmpEq.lowCut, { enabled: false, frequencyHz: 80 });
  assert.deepEqual(restored.preAmpEq.highCut, { enabled: false, frequencyHz: 12000 });
});

test('v5 share round-trip preserves and clamps independent high/low cuts', () => {
  const encoded = encodePayload({
    v: 5,
    c: [],
    a: { cat: 'crunch', key: 'builtin:crunch', on: 1, v: {} },
    b: { id: 'gb4x12', on: 1, v: {} },
    q: {
      on: 1,
      b: {},
      l: 0,
      lo: { on: 1, f: 9.4 },
      hi: { on: 1, f: 22000.2 },
    },
  });
  const restored = decodeShareState(encoded)!;
  assert.deepEqual(restored.preAmpEq.lowCut, { enabled: true, frequencyHz: 20 });
  assert.deepEqual(restored.preAmpEq.highCut, { enabled: true, frequencyHz: 20000 });
});

test('v4 share 缺失或损坏的 EQ 值按段安全回退', () => {
  const restored = decodeShareState(encodePayload({
    v: 4,
    c: [],
    a: { cat: 'clean', key: 'builtin:clean', on: 1, v: {} },
    b: { id: 'gb4x12', on: 1, v: {} },
    q: { on: 1, b: { hz31_25: 'loud', hz1000: null, hz2000: 3.5 }, l: 'quiet' },
  }))!;
  assert.equal(restored.preAmpEq.enabled, true);
  assert.equal(restored.preAmpEq.bands.hz31_25, 0);
  assert.equal(restored.preAmpEq.bands.hz1000, 0);
  assert.equal(restored.preAmpEq.bands.hz2000, 3.5);
  assert.equal(restored.preAmpEq.levelDb, 0);
});
