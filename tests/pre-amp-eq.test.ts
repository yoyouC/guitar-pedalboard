import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createStubAudioContext,
  type StubAudioNode,
  type StubBiquadFilterNode,
  type StubGainNode,
} from './helpers/stub-audio-context.ts';
import {
  PRE_AMP_EQ_BANDS,
  createDefaultPreAmpEqState,
  createPreAmpEqRuntime,
} from '../src/audio/preAmpEq.ts';

test('箱头前均衡创建固定十段单位响应，并把最高频安全限制在 Nyquist 以下', () => {
  const ctx = createStubAudioContext({ sampleRate: 32000 });
  const runtime = createPreAmpEqRuntime(
    ctx as unknown as AudioContext,
    createDefaultPreAmpEqState(),
  );
  const filters = ctx.nodesOfKind<StubBiquadFilterNode>('BiquadFilterNode');
  const gains = ctx.nodesOfKind<StubGainNode>('GainNode');

  assert.equal(filters.length, 10);
  assert.deepEqual(
    filters.map((filter) => ({ type: filter.type, frequency: filter.frequency.value, Q: filter.Q.value })),
    PRE_AMP_EQ_BANDS.map((band) => ({
      type: 'peaking',
      frequency: Math.min(band.frequency, 32000 * 0.45),
      Q: Math.SQRT2,
    })),
  );
  assert.deepEqual(filters.map((filter) => filter.gain.value), Array(10).fill(0));
  assert.equal(gains.at(-1)?.gain.value, 1, 'Bypass 默认输出 Level 为单位增益');

  const connected = (from: StubAudioNode, to: StubAudioNode) => ctx.isConnected(from, to);
  assert.ok(connected(runtime.input as unknown as StubAudioNode, filters[0]));
  for (let index = 0; index < filters.length - 1; index += 1) {
    assert.ok(connected(filters[index], filters[index + 1]));
  }
  assert.ok(connected(filters.at(-1)!, runtime.output as unknown as StubAudioNode));

  runtime.dispose();
  assert.equal(
    ctx.connections.filter((connection) =>
      connection.from === runtime.input ||
      connection.from === runtime.output ||
      filters.includes(connection.from as StubBiquadFilterNode)).length,
    0,
  );
});

test('箱头前均衡在 Bypass 中保留目标值，启用和再次 Bypass 均平滑切换', () => {
  const ctx = createStubAudioContext();
  ctx.currentTime = 1.25;
  const runtime = createPreAmpEqRuntime(
    ctx as unknown as AudioContext,
    createDefaultPreAmpEqState(),
  );
  const filters = ctx.nodesOfKind<StubBiquadFilterNode>('BiquadFilterNode');
  const output = ctx.nodesOfKind<StubGainNode>('GainNode').at(-1)!;

  runtime.setBand('hz1000', 6);
  runtime.setLevel(-3);
  assert.equal(filters[5].gain.callsOf('setTargetAtTime').length, 0, 'Bypass 中只记忆参数');
  assert.equal(output.gain.callsOf('setTargetAtTime').length, 0, 'Bypass 中 Level 不改变单位响应');

  runtime.setEnabled(true);
  assert.deepEqual(filters[5].gain.callsOf('setTargetAtTime').at(-1)?.args, [6, 1.25, 0.02]);
  assert.deepEqual(output.gain.callsOf('setTargetAtTime').at(-1)?.args, [10 ** (-3 / 20), 1.25, 0.02]);

  runtime.setEnabled(false);
  assert.deepEqual(filters[5].gain.callsOf('setTargetAtTime').at(-1)?.args, [0, 1.25, 0.02]);
  assert.deepEqual(output.gain.callsOf('setTargetAtTime').at(-1)?.args, [1, 1.25, 0.02]);
});
