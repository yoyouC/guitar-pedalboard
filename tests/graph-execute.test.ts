import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createStubAudioContext,
  StubAnalyserNode,
  StubGainNode,
  type StubAudioContext,
} from './helpers/stub-audio-context.ts';
import type { EffectInstance } from '../src/audio/effects/types.ts';
import { overdriveEffect } from '../src/audio/effects/overdrive.ts';
import { volumeEffect } from '../src/audio/effects/volume.ts';
import { delayEffect } from '../src/audio/effects/delay.ts';
import { eqEffect } from '../src/audio/effects/eq.ts';
import {
  executePlan,
  type GraphEnv,
  type GraphPlan,
} from '../src/audio/graphBuilder.ts';
import {
  createDefaultPreAmpEqState,
  createPreAmpEqRuntime,
  type PreAmpEqRuntime,
} from '../src/audio/preAmpEq.ts';

/**
 * executePlan 的冒烟测试:经 stub AudioContext 断言节点创建与接线。
 * 只用注册表里的普通效果 def(overdrive/volume/delay/eq),NAM 不进单测。
 * amp/cab 槽位同样喂普通 def——plan/execute 不区分角色的语义,只按 plan 执行。
 */

interface EnvFixture {
  env: GraphEnv;
  inputGain: StubGainNode;
  inputAnalyser: StubAnalyserNode;
  outputAnalyser: StubAnalyserNode;
  looperNode: StubGainNode;
  preAmpEq: PreAmpEqRuntime;
}

/** 按引擎 init 的方式预接固定主链路(inputGain→inputAnalyser、looper→outputAnalyser) */
function makeEnv(ctx: StubAudioContext, opts: { looper?: boolean } = {}): EnvFixture {
  const inputGain = ctx.createGain();
  const inputAnalyser = ctx.createAnalyser();
  const outputAnalyser = ctx.createAnalyser();
  const looperNode = opts.looper === false ? null : ctx.createGain();
  const preAmpEq = createPreAmpEqRuntime(
    ctx as unknown as AudioContext,
    createDefaultPreAmpEqState(),
  );
  inputGain.connect(inputAnalyser);
  looperNode?.connect(outputAnalyser);
  return {
    env: {
      inputGain: inputGain as unknown as GainNode,
      inputAnalyser: inputAnalyser as unknown as AnalyserNode,
      outputAnalyser: outputAnalyser as unknown as AnalyserNode,
      looperNode: looperNode as unknown as AudioNode | null,
      preAmpEq,
    },
    inputGain,
    inputAnalyser,
    outputAnalyser,
    looperNode: looperNode as StubGainNode,
    preAmpEq,
  };
}

function asAudioContext(ctx: StubAudioContext): AudioContext {
  return ctx as unknown as AudioContext;
}

/** 手写一个"存活实例":stub gain 进出 + 记录 update/dispose(dispose 按契约断开内部节点) */
function liveInst(ctx: StubAudioContext) {
  const updates: [string, number][] = [];
  const inst = {
    input: ctx.createGain(),
    output: ctx.createGain(),
    disposed: false,
    updates,
    update(key: string, value: number) {
      updates.push([key, value]);
    },
    dispose() {
      inst.disposed = true;
      inst.input.disconnect();
      inst.output.disconnect();
    },
  };
  return inst as typeof inst & EffectInstance;
}

/** 全结构 plan:前置 overdrive+volume → 箱头(eq) → 后置 delay → 箱体(volume def) */
function fullPlan(overrides: Partial<GraphPlan> = {}): GraphPlan {
  return {
    empty: false,
    globalBypass: false,
    dispose: [],
    pedals: [
      { uid: 'od', def: overdriveEffect, post: false, inst: null, values: { drive: 50 } },
      { uid: 'vol', def: volumeEffect, post: false, inst: null, values: { level: 0 } },
      { uid: 'dly', def: delayEffect, post: true, inst: null, values: { mix: 30 } },
    ],
    amp: { def: eqEffect, key: 'eq:0', inst: null, values: { low: 3 } },
    cab: { def: volumeEffect, key: 'cab-runtime', inst: null, values: { level: -1 } },
    ...overrides,
  };
}

test('空 plan:no-op,返回 null 且不触碰任何状态', () => {
  const ctx = createStubAudioContext();
  const { env } = makeEnv(ctx);
  const logLen = ctx.connectionLog.length;

  const artifacts = executePlan(asAudioContext(ctx), env, {
    empty: true,
    globalBypass: false,
    dispose: [],
    pedals: [],
    amp: null,
    cab: null,
  });

  assert.equal(artifacts, null);
  assert.equal(ctx.connectionLog.length, logLen, '空 plan 不产生任何 connect/disconnect');
  assert.equal(ctx.isConnected(ctx.nodesOfKind('GainNode')[0], ctx.nodesOfKind('AnalyserNode')[0]), true, '既有接线保持原样');
});

test('按 plan 创建节点:每 spec 一个实例,artifacts 归集实例与电平表', () => {
  const ctx = createStubAudioContext();
  const { env } = makeEnv(ctx);

  const artifacts = executePlan(asAudioContext(ctx), env, fullPlan())!;

  assert.ok(artifacts);
  assert.deepEqual([...artifacts.instances.keys()], ['od', 'vol', 'dly']);
  assert.deepEqual([...artifacts.moduleAnalysers.keys()], ['od', 'vol', 'dly']);
  assert.ok(artifacts.ampInstance);
  assert.equal(artifacts.ampInstanceDef, eqEffect);
  assert.equal(artifacts.ampInstanceKey, 'eq:0');
  assert.ok(artifacts.cabInstance);
  assert.equal(artifacts.cabInstanceDef, volumeEffect);
  assert.ok(artifacts.preAmpAnalyser);
  assert.ok(artifacts.ampAnalyser);
  assert.ok(artifacts.cabAnalyser);
  assert.equal(artifacts.globalBypass, false);
});

test('线性 connect 序列:inputGain → 前置链 → 箱头前EQ → preAmp tap → 箱头 → 后置链 → 箱体 → looper', () => {
  const ctx = createStubAudioContext();
  const { env, inputGain, looperNode, preAmpEq } = makeEnv(ctx);

  const artifacts = executePlan(asAudioContext(ctx), env, fullPlan())!;
  const od = artifacts.instances.get('od')!.inst;
  const vol = artifacts.instances.get('vol')!.inst;
  const dly = artifacts.instances.get('dly')!.inst;
  const amp = artifacts.ampInstance!;
  const cab = artifacts.cabInstance!;

  const connected = (a: unknown, b: unknown) =>
    ctx.isConnected(a as StubGainNode, b as StubGainNode);

  // 前置段
  assert.ok(connected(inputGain, od.input), 'inputGain → od.input');
  assert.ok(connected(od.output, vol.input), 'od → vol');
  // 箱头前 EQ 固定位于前置链末端与 preAmp 抽头/箱头之间
  assert.ok(connected(vol.output, preAmpEq.input), '前置链末端 → preAmpEq.input');
  assert.ok(connected(preAmpEq.output, artifacts.preAmpAnalyser), 'preAmpEq.output → preAmpAnalyser');
  assert.ok(connected(preAmpEq.output, amp.input), 'preAmpEq.output → amp.input');
  // 箱头 → 后置段(FX Loop)
  assert.ok(connected(amp.output, dly.input), 'amp → dly(FX Loop)');
  // 后置段 → 箱体 → looper
  assert.ok(connected(dly.output, cab.input), 'dly → cab');
  assert.ok(connected(cab.output, looperNode), 'cab → looper');
  // 无箱头/箱体时也不该出现的边:这里确认 preAmp 抽头只是旁路,不打断主链
  assert.equal(connected(inputGain, amp.input), false, '信号必须经过前置链');
});

test('每个 spec 一个 analyser tap(fftSize=1024),preAmp/amp/cab 三个 analyser 就位', () => {
  const ctx = createStubAudioContext();
  const { env } = makeEnv(ctx);

  const artifacts = executePlan(asAudioContext(ctx), env, fullPlan())!;

  for (const [uid, tap] of artifacts.moduleAnalysers) {
    const inst = artifacts.instances.get(uid)!.inst;
    assert.ok(
      ctx.isConnected(inst.output as unknown as StubGainNode, tap as unknown as StubAnalyserNode),
      `${uid} 的输出接了自己的电平表`,
    );
    assert.equal((tap as unknown as StubAnalyserNode).fftSize, 1024);
  }
  const ampTap = artifacts.ampAnalyser as unknown as StubAnalyserNode;
  const cabTap = artifacts.cabAnalyser as unknown as StubAnalyserNode;
  assert.ok(ctx.isConnected(artifacts.ampInstance!.output as unknown as StubGainNode, ampTap));
  assert.ok(ctx.isConnected(artifacts.cabInstance!.output as unknown as StubGainNode, cabTap));
  assert.equal(ampTap.fftSize, 1024);
  assert.equal(cabTap.fftSize, 1024);
  assert.equal((artifacts.preAmpAnalyser as unknown as StubAnalyserNode).fftSize, 1024);
});

test('dispose 先于接线:旧实例销毁,且全部 disconnect 事件先于全部 connect 事件', () => {
  const ctx = createStubAudioContext();
  const { env, inputGain } = makeEnv(ctx);
  const oldOd = liveInst(ctx);
  const oldAmp = liveInst(ctx);
  // 旧图:inputGain → oldOd,旧实例挂在图上
  inputGain.connect(oldOd.input);
  oldOd.output.connect(oldAmp.input);
  const logBefore = ctx.connectionLog.length;

  const plan = fullPlan({ dispose: [oldOd, oldAmp] });
  const artifacts = executePlan(asAudioContext(ctx), env, plan)!;

  assert.equal(oldOd.disposed, true);
  assert.equal(oldAmp.disposed, true);
  const log = ctx.connectionLog.slice(logBefore);
  const firstConnect = log.findIndex((e) => e.type === 'connect');
  const lastDisconnect = log.map((e, i) => (e.type === 'disconnect' ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  assert.ok(firstConnect >= 0, '有新接线');
  assert.ok(lastDisconnect < firstConnect, '所有 disconnect 先于所有 connect');
  // 旧边已拆除
  assert.equal(ctx.isConnected(inputGain, oldOd.input), false);
  assert.equal(ctx.isConnected(oldOd.output, oldAmp.input), false);
  assert.ok(artifacts.instances.get('od')!.inst !== oldOd, '新实例替代旧实例');
});

test('复用实例:不重建、回放 spec 参数、断开旧下游后按新序重接', () => {
  const ctx = createStubAudioContext();
  const { env, inputGain, looperNode, preAmpEq } = makeEnv(ctx);
  const kept = liveInst(ctx);
  const staleTap = ctx.createAnalyser();
  inputGain.connect(kept.input);
  kept.output.connect(staleTap);
  kept.output.connect(looperNode);

  const plan = fullPlan({
    pedals: [
      { uid: 'od', def: overdriveEffect, post: false, inst: kept, values: { drive: 80, level: 2 } },
    ],
    amp: null,
    cab: null,
  });
  const artifacts = executePlan(asAudioContext(ctx), env, plan)!;

  assert.equal(artifacts.instances.get('od')!.inst, kept, '实例原样保留');
  assert.deepEqual(kept.updates, [
    ['drive', 80],
    ['level', 2],
  ], '复用实例回放 spec 参数');
  assert.equal(ctx.isConnected(kept.output, staleTap), false, '旧电平抽头被断开');
  // 重新接线:kept 是前置链末端 → 箱头前 EQ → preAmp tap + looper(主链)
  assert.ok(ctx.isConnected(kept.output, preAmpEq.input as unknown as StubGainNode));
  assert.ok(
    ctx.isConnected(
      preAmpEq.output as unknown as StubGainNode,
      artifacts.preAmpAnalyser as unknown as StubAnalyserNode,
    ),
  );
  const newTap = artifacts.moduleAnalysers.get('od') as unknown as StubAnalyserNode;
  assert.ok(newTap, '复用实例也获得新的模块电平表');
  assert.ok(ctx.isConnected(kept.output, newTap));
  assert.ok(
    ctx.isConnected(preAmpEq.output as unknown as StubGainNode, looperNode),
    '断开旧下游后经箱头前 EQ 重接回 looper',
  );
});

test('globalBypass:inputGain 直连 looper/output,保留 kept 实例,不新建不接线', () => {
  const ctx = createStubAudioContext();
  const { env, inputGain, looperNode, preAmpEq } = makeEnv(ctx);
  const kept = liveInst(ctx);
  const keptAmp = liveInst(ctx);
  const gainCount = ctx.nodesOfKind('GainNode').length;

  const artifacts = executePlan(asAudioContext(ctx), env, {
    empty: false,
    globalBypass: true,
    dispose: [],
    pedals: [{ uid: 'od', def: overdriveEffect, post: false, inst: kept, values: {} }],
    amp: { def: eqEffect, key: 'eq:0', inst: keptAmp, values: {} },
    cab: null,
  })!;

  assert.ok(ctx.isConnected(inputGain, looperNode), 'bypass:inputGain 直连 looper');
  assert.equal(
    ctx.isConnected(inputGain, preAmpEq.input as unknown as StubGainNode),
    false,
    '全局 Bypass 不进入箱头前 EQ',
  );
  assert.equal(ctx.nodesOfKind('GainNode').length, gainCount, 'bypass 不新建任何节点');
  assert.deepEqual(kept.updates, [], 'bypass 不回放参数');
  assert.equal(artifacts.instances.get('od')!.inst, kept, '保留单块实例');
  assert.equal(artifacts.ampInstance, keptAmp, '保留箱头实例');
  assert.equal(artifacts.ampInstanceKey, 'eq:0');
  assert.equal(artifacts.cabInstance, null);
  assert.equal(artifacts.moduleAnalysers.size, 0);
  assert.equal(artifacts.preAmpAnalyser, null);
  assert.equal(artifacts.ampAnalyser, null);
  assert.equal(artifacts.cabAnalyser, null);
});

test('looper 缺失时安全直通:末端落到 outputAnalyser', () => {
  const ctx = createStubAudioContext();
  const { env, inputGain, outputAnalyser, preAmpEq } = makeEnv(ctx, { looper: false });

  const artifacts = executePlan(asAudioContext(ctx), env, fullPlan({ pedals: [], amp: null, cab: null }))!;
  assert.ok(ctx.isConnected(inputGain, preAmpEq.input as unknown as StubGainNode));
  assert.ok(
    ctx.isConnected(preAmpEq.output as unknown as StubGainNode, outputAnalyser),
    '无 looper:非 Bypass 仍经过箱头前 EQ 后落到 outputAnalyser',
  );
  assert.ok(artifacts.preAmpAnalyser, '非 bypass 总有 preAmp 抽头');

  const bypassArtifacts = executePlan(asAudioContext(ctx), env, {
    empty: false,
    globalBypass: true,
    dispose: [],
    pedals: [],
    amp: null,
    cab: null,
  })!;
  assert.ok(ctx.isConnected(inputGain, outputAnalyser), 'bypass + 无 looper 同样直通 outputAnalyser');
  assert.equal(bypassArtifacts.globalBypass, true);
});
