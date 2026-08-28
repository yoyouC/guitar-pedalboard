import assert from 'node:assert/strict';
import test from 'node:test';
import { createCabIrEffect } from '../src/audio/cabIrEffect.ts';
import { CAB_IR_RUNTIME_DEF, stageInitialCabIrBuffer } from '../src/audio/cabIrRuntime.ts';
import {
  StubConvolverNode,
  StubGainNode,
  createStubAudioContext,
} from './helpers/stub-audio-context.ts';

test('IR cab uses normalize=false and never changes active Convolver.buffer in place', () => {
  const ctx = createStubAudioContext();
  const first = ctx.createBuffer(1, 16, 48_000);
  const second = ctx.createBuffer(2, 32, 48_000);
  const effect = createCabIrEffect(ctx as unknown as AudioContext, first as unknown as AudioBuffer);
  const firstConvolver = ctx.nodesOfKind<StubConvolverNode>('ConvolverNode')[0];

  effect.switchBuffer(second as unknown as AudioBuffer);
  const convolvers = ctx.nodesOfKind<StubConvolverNode>('ConvolverNode');

  assert.equal(convolvers.length, 2);
  assert.equal(firstConvolver.normalize, false);
  assert.equal(firstConvolver.buffer, first);
  assert.equal(convolvers[1].normalize, false);
  assert.equal(convolvers[1].buffer, second);
});

test('IR change schedules an approximately equal-power 30ms crossfade', () => {
  const ctx = createStubAudioContext();
  const first = ctx.createBuffer(1, 8, 48_000);
  const second = ctx.createBuffer(1, 8, 48_000);
  const effect = createCabIrEffect(ctx as unknown as AudioContext, first as unknown as AudioBuffer);
  effect.switchBuffer(second as unknown as AudioBuffer);
  const laneGains = ctx.nodesOfKind<StubGainNode>('GainNode').slice(2);
  const ramps = laneGains.flatMap((node) => node.gain.callsOf('linearRampToValueAtTime'));

  assert.ok(ramps.some((call) => Math.abs(call.args[1] - 0.03) < 1e-6));
  assert.ok(ramps.some((call) => Math.abs(call.args[0] - Math.SQRT1_2) < 0.02));
});

test('asset calibration gain is independent from the user LEVEL output gain', () => {
  const ctx = createStubAudioContext();
  const first = ctx.createBuffer(1, 8, 48_000);
  const second = ctx.createBuffer(1, 8, 48_000);
  const effect = createCabIrEffect(
    ctx as unknown as AudioContext,
    first as unknown as AudioBuffer,
    -2,
    -12,
  );
  const gains = ctx.nodesOfKind<StubGainNode>('GainNode');

  assert.ok(Math.abs(gains[1].gain.value - 10 ** (-2 / 20)) < 1e-6);
  assert.ok(Math.abs(gains[2].gain.value - 10 ** (-12 / 20)) < 1e-6);

  effect.switchBuffer(second as unknown as AudioBuffer, -6);
  const nextLane = ctx.nodesOfKind<StubGainNode>('GainNode')[3];
  const ramps = nextLane.gain.callsOf('linearRampToValueAtTime');
  assert.ok(Math.abs(ramps.at(-1)!.args[0] - 10 ** (-6 / 20)) < 1e-6);
  effect.dispose();
});

test('rapid IR choices keep only one pending transition instead of adding a third lane', async () => {
  const ctx = createStubAudioContext();
  const first = ctx.createBuffer(1, 8, 48_000);
  const second = ctx.createBuffer(1, 8, 48_000);
  const latest = ctx.createBuffer(1, 8, 48_000);
  const effect = createCabIrEffect(ctx as unknown as AudioContext, first as unknown as AudioBuffer);

  effect.switchBuffer(second as unknown as AudioBuffer);
  effect.switchBuffer(latest as unknown as AudioBuffer);
  assert.equal(ctx.nodesOfKind<StubConvolverNode>('ConvolverNode').length, 2);

  await new Promise((resolve) => setTimeout(resolve, 40));
  const convolvers = ctx.nodesOfKind<StubConvolverNode>('ConvolverNode');
  assert.equal(convolvers.length, 3);
  assert.equal(convolvers[2].buffer, latest);
  assert.equal(ctx.connections.some((connection) => connection.from === convolvers[0]), false);
  effect.dispose();
});

test('a Cab runtime recreated after CAB OFF starts from the latest staged IR', () => {
  const ctx = createStubAudioContext();
  const startup = ctx.createBuffer(1, 8, 48_000);
  const latest = ctx.createBuffer(1, 8, 48_000);
  stageInitialCabIrBuffer(ctx as unknown as AudioContext, startup as unknown as AudioBuffer);
  stageInitialCabIrBuffer(ctx as unknown as AudioContext, latest as unknown as AudioBuffer);

  const effect = CAB_IR_RUNTIME_DEF.create(ctx as unknown as AudioContext);
  const convolver = ctx.nodesOfKind<StubConvolverNode>('ConvolverNode')[0];
  assert.equal(convolver.buffer, latest);
  effect.dispose();
});
