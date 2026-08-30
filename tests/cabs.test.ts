import assert from 'node:assert/strict';
import test from 'node:test';
import { CAB_SELECTOR_REGISTRY, getCabDef } from '../src/audio/cabs.ts';
import {
  StubBiquadFilterNode,
  StubConvolverNode,
  StubGainNode,
  createStubAudioContext,
} from './helpers/stub-audio-context.ts';

test('four default cabinets use Biquad DSP and Custom IR remains the only convolution option', () => {
  const expected = {
    open1x12: { hp: 100, low: [120, 1.5], peak: [3500, 2, 1.2], lp: 6000, level: -1 },
    blue2x12: { hp: 85, low: [110, 2], peak: [3200, 3, 1.3], lp: 5500, level: -1.5 },
    gb4x12: { hp: 75, low: [100, 3], peak: [2800, 4, 1.2], lp: 5000, level: -2 },
    v304x12: { hp: 80, low: [90, 2], peak: [2400, 5, 1.5], lp: 4800, level: -2 },
  } as const;
  assert.deepEqual(
    CAB_SELECTOR_REGISTRY.map((definition) => definition.id),
    ['open1x12', 'blue2x12', 'gb4x12', 'v304x12', 'customIr'],
  );

  for (const id of Object.keys(expected) as Array<keyof typeof expected>) {
    const ctx = createStubAudioContext();
    const instance = getCabDef(id).create(ctx as unknown as AudioContext);
    const filters = ctx.nodesOfKind<StubBiquadFilterNode>('BiquadFilterNode');
    assert.deepEqual(filters.map((filter) => filter.type), [
      'highpass', 'peaking', 'peaking', 'lowpass', 'lowpass',
    ]);
    assert.equal(filters[0].frequency.value, expected[id].hp);
    assert.deepEqual(
      [filters[1].frequency.value, filters[1].gain.value, filters[1].Q.value],
      [...expected[id].low, 1],
    );
    assert.deepEqual(
      [filters[2].frequency.value, filters[2].gain.value, filters[2].Q.value],
      expected[id].peak,
    );
    assert.deepEqual(
      [filters[3].frequency.value, filters[4].frequency.value],
      [expected[id].lp, expected[id].lp],
    );
    assert.equal(ctx.nodesOfKind<StubConvolverNode>('ConvolverNode').length, 0);
    const output = ctx.nodesOfKind<StubGainNode>('GainNode')[1];
    assert.ok(Math.abs(output.gain.value - 10 ** (expected[id].level / 20)) < 1e-6);
    instance.dispose();
  }
});
