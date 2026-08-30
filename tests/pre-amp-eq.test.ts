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
  PRE_AMP_EQ_CUT_Q,
  createDefaultPreAmpEqState,
  createPreAmpEqRuntime,
  normalizePreAmpEqCutFrequency,
} from '../src/audio/preAmpEq.ts';

test('箱头前均衡按 HPF → 十段 → LPF → Level 建图，切频使用 12 dB/oct Butterworth', () => {
  const ctx = createStubAudioContext({ sampleRate: 32000 });
  const runtime = createPreAmpEqRuntime(
    ctx as unknown as AudioContext,
    createDefaultPreAmpEqState(),
  );
  const filters = ctx.nodesOfKind<StubBiquadFilterNode>('BiquadFilterNode');
  const gains = ctx.nodesOfKind<StubGainNode>('GainNode');
  const lowCut = filters[0];
  const graphicFilters = filters.slice(1, 11);
  const highCut = filters[11];
  const [input, lowDry, lowWet, lowSum, highDry, highWet, highSum, output] = gains;

  assert.equal(filters.length, 12);
  assert.deepEqual(
    { type: lowCut.type, frequency: lowCut.frequency.value, Q: lowCut.Q.value },
    { type: 'highpass', frequency: 80, Q: PRE_AMP_EQ_CUT_Q },
  );
  assert.deepEqual(
    graphicFilters.map((filter) => ({ type: filter.type, frequency: filter.frequency.value, Q: filter.Q.value })),
    PRE_AMP_EQ_BANDS.map((band) => ({
      type: 'peaking',
      frequency: Math.min(band.frequency, 32000 * 0.45),
      Q: Math.SQRT2,
    })),
  );
  assert.deepEqual(
    { type: highCut.type, frequency: highCut.frequency.value, Q: highCut.Q.value },
    { type: 'lowpass', frequency: 12000, Q: PRE_AMP_EQ_CUT_Q },
  );
  assert.deepEqual(graphicFilters.map((filter) => filter.gain.value), Array(10).fill(0));
  assert.equal(lowDry.gain.value, 1);
  assert.equal(lowWet.gain.value, 0);
  assert.equal(highDry.gain.value, 1);
  assert.equal(highWet.gain.value, 0);
  assert.equal(output.gain.value, 1, 'Bypass 默认输出 Level 为单位增益');

  const connected = (from: StubAudioNode, to: StubAudioNode) => ctx.isConnected(from, to);
  assert.ok(connected(input, lowDry));
  assert.ok(connected(input, lowCut));
  assert.ok(connected(lowCut, lowWet));
  assert.ok(connected(lowDry, lowSum));
  assert.ok(connected(lowWet, lowSum));
  assert.ok(connected(lowSum, graphicFilters[0]));
  for (let index = 0; index < graphicFilters.length - 1; index += 1) {
    assert.ok(connected(graphicFilters[index], graphicFilters[index + 1]));
  }
  assert.ok(connected(graphicFilters.at(-1)!, highDry));
  assert.ok(connected(graphicFilters.at(-1)!, highCut));
  assert.ok(connected(highCut, highWet));
  assert.ok(connected(highDry, highSum));
  assert.ok(connected(highWet, highSum));
  assert.ok(connected(highSum, output));
  assert.equal(runtime.input, input as unknown as GainNode);
  assert.equal(runtime.output, output as unknown as GainNode);

  runtime.dispose();
  assert.equal(ctx.connections.length, 0);
});

test('箱头前均衡在总 Bypass 中保留全部目标值，启用与旁路均平滑且切频回到精确干声', () => {
  const ctx = createStubAudioContext({ sampleRate: 32000 });
  ctx.currentTime = 1.25;
  const runtime = createPreAmpEqRuntime(
    ctx as unknown as AudioContext,
    createDefaultPreAmpEqState(),
  );
  const filters = ctx.nodesOfKind<StubBiquadFilterNode>('BiquadFilterNode');
  const gains = ctx.nodesOfKind<StubGainNode>('GainNode');
  const graphic1k = filters[6];
  const highCut = filters[11];
  const lowDry = gains[1];
  const lowWet = gains[2];
  const highDry = gains[4];
  const highWet = gains[5];
  const output = gains[7];

  runtime.setBand('hz1000', 6);
  runtime.setLevel(-3);
  runtime.setCutEnabled('lowCut', true);
  runtime.setCutEnabled('highCut', true);
  runtime.setCutFrequency('highCut', 20000);
  assert.equal(graphic1k.gain.callsOf('setTargetAtTime').length, 0, 'Bypass 中只记忆频段参数');
  assert.equal(output.gain.callsOf('setTargetAtTime').length, 0, 'Bypass 中 Level 不改变单位响应');
  assert.deepEqual(highCut.frequency.callsOf('setTargetAtTime').at(-1)?.args, [14400, 1.25, 0.02]);

  runtime.setEnabled(true);
  assert.deepEqual(graphic1k.gain.callsOf('setTargetAtTime').at(-1)?.args, [6, 1.25, 0.02]);
  assert.deepEqual(output.gain.callsOf('setTargetAtTime').at(-1)?.args, [10 ** (-3 / 20), 1.25, 0.02]);
  assert.deepEqual(lowDry.gain.callsOf('linearRampToValueAtTime').at(-1)?.args, [0, 1.27]);
  assert.deepEqual(lowWet.gain.callsOf('linearRampToValueAtTime').at(-1)?.args, [1, 1.27]);
  assert.deepEqual(highDry.gain.callsOf('linearRampToValueAtTime').at(-1)?.args, [0, 1.27]);
  assert.deepEqual(highWet.gain.callsOf('linearRampToValueAtTime').at(-1)?.args, [1, 1.27]);

  runtime.setEnabled(false);
  assert.deepEqual(graphic1k.gain.callsOf('setTargetAtTime').at(-1)?.args, [0, 1.25, 0.02]);
  assert.deepEqual(output.gain.callsOf('setTargetAtTime').at(-1)?.args, [1, 1.25, 0.02]);
  assert.deepEqual(lowDry.gain.callsOf('linearRampToValueAtTime').at(-1)?.args, [1, 1.27]);
  assert.deepEqual(lowWet.gain.callsOf('linearRampToValueAtTime').at(-1)?.args, [0, 1.27]);
  assert.deepEqual(highDry.gain.callsOf('linearRampToValueAtTime').at(-1)?.args, [1, 1.27]);
  assert.deepEqual(highWet.gain.callsOf('linearRampToValueAtTime').at(-1)?.args, [0, 1.27]);
});

test('高低切频率 canonical 限制各自范围并量化到整数 Hz', () => {
  assert.equal(normalizePreAmpEqCutFrequency('lowCut', 9), 20);
  assert.equal(normalizePreAmpEqCutFrequency('lowCut', 80.6), 81);
  assert.equal(normalizePreAmpEqCutFrequency('lowCut', Infinity), 80);
  assert.equal(normalizePreAmpEqCutFrequency('highCut', 999), 1000);
  assert.equal(normalizePreAmpEqCutFrequency('highCut', 22000), 20000);
  assert.equal(normalizePreAmpEqCutFrequency('highCut', Number.NaN), 12000);
});
