import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createStubAudioContext,
  StubAudioWorkletNode,
  StubBiquadFilterNode,
  StubGainNode,
  StubWaveShaperNode,
  StubAudioNode,
} from './helpers/stub-audio-context.ts';
import { overdriveEffect } from '../src/audio/effects/overdrive.ts';

/** 从 from 出发沿存活连接走,断言依次经过 expectedKinds,最终到达 to */
function assertChain(
  from: StubAudioNode,
  to: StubAudioNode,
  expectedKinds: string[],
): StubAudioNode[] {
  const path: StubAudioNode[] = [from];
  let cur = from;
  while (cur !== to) {
    const edge = cur.context.connections.find(
      (c) => c.from === cur && c.to instanceof StubAudioNode && !path.includes(c.to),
    );
    assert.ok(edge, `链在 ${cur.kind}#${cur.id} 处断开,未到达 ${to.kind}#${to.id}`);
    cur = edge.to as StubAudioNode;
    path.push(cur);
  }
  assert.deepEqual(path.map((n) => n.kind), expectedKinds);
  return path;
}

test('stub 记录节点创建:类型、worklet 构造名与创建顺序', () => {
  const ctx = createStubAudioContext();
  assert.equal(ctx.destination.kind, 'AudioDestinationNode');
  assert.equal(ctx.destination.id, 1);

  const gain = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  const worklet = new StubAudioWorkletNode(ctx, 'wdf-twin', { outputChannelCount: [2] });

  assert.equal(gain.id, 2);
  assert.equal(filter.id, 3);
  assert.deepEqual(ctx.nodesOfKind('GainNode'), [gain]);
  assert.equal(worklet.kind, 'AudioWorkletNode');
  assert.equal(worklet.processorName, 'wdf-twin');
  assert.deepEqual(worklet.options.outputChannelCount, [2]);
});

test('stub 记录连接:谁连了谁(含到 AudioParam 的调制边),disconnect 后移除', () => {
  const ctx = createStubAudioContext();
  const lfo = ctx.createOscillator();
  const depth = ctx.createGain();
  const delay = ctx.createDelay(1);

  lfo.connect(depth);
  depth.connect(delay.delayTime);
  delay.connect(ctx.destination);

  assert.equal(ctx.isConnected(lfo, depth), true);
  assert.equal(ctx.isConnected(depth, delay.delayTime), true);
  assert.equal(ctx.isConnected(delay, ctx.destination), true);
  assert.equal(ctx.isConnected(lfo, delay), false);

  // 无参 disconnect 移除该节点全部出边,并记入事件日志
  depth.disconnect();
  assert.equal(ctx.isConnected(depth, delay.delayTime), false);
  assert.equal(ctx.isConnected(lfo, depth), true, 'disconnect 只移除自己的出边');
  const last = ctx.connectionLog.at(-1);
  assert.deepEqual({ type: last?.type, from: last?.from, to: last?.to }, {
    type: 'disconnect',
    from: depth,
    to: null,
  });
});

test('stub 记录参数调用:value 赋值与 setTargetAtTime 含全部实参', () => {
  const ctx = createStubAudioContext();
  const filter = ctx.createBiquadFilter();

  filter.frequency.value = 3000;
  ctx.currentTime = 1.5;
  filter.frequency.setTargetAtTime(5000, ctx.currentTime, 0.03);

  assert.deepEqual(filter.frequency.calls, [
    { method: 'setValue', args: [3000] },
    { method: 'setTargetAtTime', args: [5000, 1.5, 0.03] },
  ]);
  assert.equal(filter.frequency.value, 5000);
  assert.equal(filter.frequency.owner, filter);
  assert.equal(filter.frequency.name, 'frequency');
});

test('stub worklet 节点:parameters.get 惰性建参并记录调用,port 记录消息', () => {
  const ctx = createStubAudioContext();
  const node = new StubAudioWorkletNode(ctx, 'wdf-tapedelay');

  node.parameters.get('mix')?.setTargetAtTime(30, 0, 0.03);
  assert.deepEqual(node.parameters.get('mix')?.callsOf('setTargetAtTime'), [
    { method: 'setTargetAtTime', args: [30, 0, 0.03] },
  ]);

  node.port.postMessage({ type: 'ping' });
  assert.deepEqual(node.port.messages, [{ type: 'ping' }]);
});

test('冒烟:经过 EffectDefinition 接口构建 overdrive,断言图结构与参数记录', () => {
  const ctx = createStubAudioContext();
  const inst = overdriveEffect.create(ctx as unknown as AudioContext);
  const input = inst.input as unknown as StubGainNode;
  const output = inst.output as unknown as StubGainNode;

  // 链路:input → preGain → WaveShaper → tone(lowpass) → output
  const [, , shaper, tone] = assertChain(input, output, [
    'GainNode',
    'GainNode',
    'WaveShaperNode',
    'BiquadFilterNode',
    'GainNode',
  ]);

  // 静态初始值经过 value 赋值被记录
  const shaperNode = shaper as StubWaveShaperNode;
  assert.ok(shaperNode.curve instanceof Float32Array);
  assert.equal(shaperNode.oversample, '4x');
  const toneNode = tone as StubBiquadFilterNode;
  assert.equal(toneNode.type, 'lowpass');
  assert.deepEqual(toneNode.frequency.callsOf('setValue').at(-1)?.args, [3000]);

  // update 经过 setTargetAtTime 平滑
  inst.update('tone', 5000);
  assert.deepEqual(toneNode.frequency.callsOf('setTargetAtTime').at(-1)?.args, [5000, 0, 0.03]);

  // dispose 断开全部内部节点
  inst.dispose();
  assert.equal(ctx.connections.length, 0);
  assert.equal(
    ctx.connectionLog.filter((e) => e.type === 'disconnect').length,
    5,
  );
});
