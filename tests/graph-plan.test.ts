import assert from 'node:assert/strict';
import test from 'node:test';
import type { EffectDefinition, EffectInstance } from '../src/audio/effects/types.ts';
import {
  planGraph,
  type AmpSpec,
  type ChainSpec,
  type GraphPrevState,
  type GraphSpec,
  type PedalEntry,
} from '../src/audio/graphBuilder.ts';

/**
 * planGraph 是纯决策函数:不触碰 WebAudio、不调用 def.create。
 * 这里用假 def(create 直接 throw)与假实例(仅标记身份)钉住复用/销毁/回放契约。
 */

function fakeDef(id: string): EffectDefinition {
  return {
    id,
    name: id,
    color: '#000000',
    params: [],
    create: () => {
      throw new Error(`planGraph 不应调用 create(${id})`);
    },
  };
}

interface FakeInst extends EffectInstance {
  label: string;
  disposed: boolean;
  updates: [string, number][];
}

function fakeInst(label: string): FakeInst {
  return {
    label,
    disposed: false,
    updates: [],
    input: {} as GainNode,
    output: {
      disconnect: () => {},
    } as unknown as GainNode,
    update(key: string, value: number) {
      this.updates.push([key, value]);
    },
    dispose() {
      this.disposed = true;
    },
  };
}

function pedal(
  uid: string,
  def: EffectDefinition,
  overrides: Partial<ChainSpec> = {},
): ChainSpec {
  return { uid, def, enabled: true, values: { level: 1 }, post: false, ...overrides };
}

function ampSpec(
  def: EffectDefinition,
  overrides: Partial<AmpSpec> = {},
): AmpSpec {
  return { def, enabled: true, values: { gain: 5 }, ...overrides };
}

function emptyPrev(overrides: Partial<GraphPrevState> = {}): GraphPrevState {
  return {
    instances: new Map(),
    ampInstance: null,
    ampInstanceDef: null,
    ampInstanceKey: null,
    cabInstance: null,
    cabInstanceDef: null,
    cabInstanceKey: null,
    globalBypass: false,
    ...overrides,
  };
}

function specOf(overrides: Partial<GraphSpec> = {}): GraphSpec {
  return { chain: [], amp: null, cab: null, globalBypass: false, ...overrides };
}

function prevWithPedals(
  entries: [string, EffectDefinition, FakeInst, boolean?][],
  overrides: Partial<GraphPrevState> = {},
): GraphPrevState {
  const instances = new Map<string, PedalEntry>();
  for (const [uid, def, inst, post] of entries) {
    instances.set(uid, { def, key: null, post: post ?? false, inst });
  }
  return emptyPrev({ instances, ...overrides });
}

// ---------- 单块复用契约:uid+def ----------

test('单块 uid+def 相同 → 复用存活实例(他处结构变化时),dispose 不含它', () => {
  const def = fakeDef('overdrive');
  const inst = fakeInst('od-1');
  const prev = prevWithPedals([['u1', def, inst]]);
  // 新增一个单块制造结构变化;u1 不变
  const plan = planGraph(specOf({ chain: [pedal('u1', def), pedal('u2', fakeDef('delay'))] }), prev);

  assert.equal(plan.empty, false);
  assert.deepEqual(plan.dispose, []);
  assert.equal(plan.pedals.length, 2);
  assert.equal(plan.pedals[0].uid, 'u1');
  assert.equal(plan.pedals[0].inst, inst, '复用同一实例引用');
  assert.equal(plan.pedals[1].inst, null, '新单块新建');
});

test('单块 uid 变化 → 旧实例进 dispose,新单块标记为新建(inst=null)', () => {
  const def = fakeDef('overdrive');
  const inst = fakeInst('od-1');
  const prev = prevWithPedals([['u1', def, inst]]);
  const plan = planGraph(specOf({ chain: [pedal('u2', def)] }), prev);

  assert.deepEqual(plan.dispose, [inst]);
  assert.equal(plan.pedals.length, 1);
  assert.equal(plan.pedals[0].uid, 'u2');
  assert.equal(plan.pedals[0].inst, null, 'uid 变了必须重建');
});

test('单块 uid 同但 def 变 → 重建(旧实例 dispose)', () => {
  const defA = fakeDef('overdrive');
  const defB = fakeDef('distortion');
  const inst = fakeInst('od-1');
  const prev = prevWithPedals([['u1', defA, inst]]);
  const plan = planGraph(specOf({ chain: [pedal('u1', defB)] }), prev);

  assert.deepEqual(plan.dispose, [inst]);
  assert.equal(plan.pedals[0].inst, null);
  assert.equal(plan.pedals[0].def, defB);
});

test('模型单块 uid+def 相同但 key 变化 → 只重建该单块', () => {
  const def = fakeDef('tone3000Nam');
  const inst = fakeInst('tone-1');
  const prev = emptyPrev({
    instances: new Map([
      ['u1', { def, key: 'tone3000:10:model:1', post: false, inst } as PedalEntry],
    ]),
  });
  const plan = planGraph(
    specOf({ chain: [pedal('u1', def, { key: 'tone3000:10:model:2' })] }),
    prev,
  );

  assert.equal(plan.empty, false);
  assert.deepEqual(plan.dispose, [inst]);
  assert.equal(plan.pedals[0].inst, null);
  assert.equal(plan.pedals[0].key, 'tone3000:10:model:2');
});

// ---------- 箱头复用契约:def+key ----------

test('箱头 def+key 相同且启用 → 复用(避免 NAM 重载)', () => {
  const def = fakeDef('nam-wasm');
  const amp = fakeInst('amp-1');
  const prev = emptyPrev({
    ampInstance: amp,
    ampInstanceDef: def,
    ampInstanceKey: 'nam-wasm:3',
  });
  const plan = planGraph(specOf({ amp: ampSpec(def, { key: 'nam-wasm:3' }) }), prev);

  assert.equal(plan.empty, true, '仅箱头复用命中且无其他变化 → 空 plan');
});

test('箱头 def+key 复用:有其他结构变化时,plan.amp.inst 为存活实例', () => {
  const def = fakeDef('nam-wasm');
  const amp = fakeInst('amp-1');
  const prev = emptyPrev({
    ampInstance: amp,
    ampInstanceDef: def,
    ampInstanceKey: 'nam-wasm:3',
  });
  const plan = planGraph(
    specOf({ chain: [pedal('u1', fakeDef('overdrive'))], amp: ampSpec(def, { key: 'nam-wasm:3' }) }),
    prev,
  );

  assert.equal(plan.empty, false);
  assert.deepEqual(plan.dispose, []);
  assert.equal(plan.amp?.inst, amp, '箱头实例复用,不重建');
  assert.equal(plan.amp?.key, 'nam-wasm:3');
});

test('箱头 key 变化 → 销毁重建(NAM 模型换代)', () => {
  const def = fakeDef('nam-wasm');
  const amp = fakeInst('amp-1');
  const prev = emptyPrev({
    ampInstance: amp,
    ampInstanceDef: def,
    ampInstanceKey: 'nam-wasm:3',
  });
  const plan = planGraph(specOf({ amp: ampSpec(def, { key: 'nam-wasm:4' }) }), prev);

  assert.deepEqual(plan.dispose, [amp]);
  assert.equal(plan.amp?.inst, null, 'key 变了必须重建');
  assert.equal(plan.amp?.key, 'nam-wasm:4');
});

test('箱头 def 变化 → 销毁重建;key 缺省按 null 比对', () => {
  const defA = fakeDef('clean');
  const defB = fakeDef('crunch');
  const amp = fakeInst('amp-1');
  const prev = emptyPrev({ ampInstance: amp, ampInstanceDef: defA, ampInstanceKey: null });
  const plan = planGraph(specOf({ amp: ampSpec(defB) }), prev);

  assert.deepEqual(plan.dispose, [amp]);
  assert.equal(plan.amp?.inst, null);

  // key 缺省 ↔ null 视为相同
  const prev2 = emptyPrev({ ampInstance: amp, ampInstanceDef: defA, ampInstanceKey: null });
  const plan2 = planGraph(specOf({ amp: ampSpec(defA) }), prev2);
  assert.equal(plan2.empty, true);
});

test('箱头被禁用 → 存活实例销毁,plan.amp 为 null', () => {
  const def = fakeDef('crunch');
  const amp = fakeInst('amp-1');
  const prev = emptyPrev({ ampInstance: amp, ampInstanceDef: def, ampInstanceKey: 'crunch:0' });
  const plan = planGraph(specOf({ amp: ampSpec(def, { enabled: false, key: 'crunch:0' }) }), prev);

  assert.deepEqual(plan.dispose, [amp]);
  assert.equal(plan.amp, null);
});

// ---------- 箱体稳定 Runtime:def+key 复用 ----------

test('箱体 def+key 不变:其他结构变化时复用稳定 Runtime', () => {
  const cabDef = fakeDef('gb4x12');
  const cab = fakeInst('cab-1');
  const prev = emptyPrev({ cabInstance: cab, cabInstanceDef: cabDef });
  // 链上新增单块 = 结构变化
  const plan = planGraph(
    specOf({ chain: [pedal('u1', fakeDef('overdrive'))], cab: ampSpec(cabDef) }),
    prev,
  );

  assert.equal(plan.empty, false);
  assert.deepEqual(plan.dispose, []);
  assert.ok(plan.cab, '箱体启用时 plan.cab 存在');
  assert.equal(plan.cab?.def, cabDef);
  assert.equal(plan.cab?.inst, cab);
});

test('箱体 def 变化 → 非空 plan(箱体无法靠实例判定 def,由 prevState 记录)', () => {
  const cabA = fakeDef('gb4x12');
  const cabB = fakeDef('v30');
  const cab = fakeInst('cab-1');
  const prev = emptyPrev({ cabInstance: cab, cabInstanceDef: cabA });
  const plan = planGraph(specOf({ cab: ampSpec(cabB) }), prev);

  assert.equal(plan.empty, false);
  assert.deepEqual(plan.dispose, [cab]);
  assert.equal(plan.cab?.def, cabB);
});

// ---------- dispose 顺序:单块 → 箱头 → 箱体,先于创建 ----------

test('dispose 清单按 单块 → 箱头 → 箱体 排序,与创建/接线清单分离', () => {
  const odDef = fakeDef('overdrive');
  const ampDef = fakeDef('crunch');
  const cabDef = fakeDef('gb4x12');
  const od = fakeInst('od-1');
  const amp = fakeInst('amp-1');
  const cab = fakeInst('cab-1');
  const prev = prevWithPedals([['u1', odDef, od]], {
    ampInstance: amp,
    ampInstanceDef: ampDef,
    ampInstanceKey: null,
    cabInstance: cab,
    cabInstanceDef: cabDef,
  });
  // 全部换掉:单块 uid 变、箱头 def 变、箱体 def 变
  const plan = planGraph(
    specOf({
      chain: [pedal('u2', odDef)],
      amp: ampSpec(fakeDef('recto')),
      cab: ampSpec(fakeDef('v30')),
    }),
    prev,
  );

  assert.deepEqual(plan.dispose, [od, amp, cab], 'dispose 顺序:单块 → 箱头 → 箱体');
  // 创建决策独立于 dispose:三个角色都用 inst=null 表示新建
  assert.equal(plan.pedals[0].inst, null);
  assert.equal(plan.amp?.inst, null);
  assert.ok(plan.cab);
});

// ---------- 空 plan:spec 无结构变化 ----------

test('结构完全不变 → 空 plan(冗余四写消解)', () => {
  const odDef = fakeDef('overdrive');
  const ampDef = fakeDef('crunch');
  const cabDef = fakeDef('gb4x12');
  const prev = prevWithPedals(
    [
      ['u1', odDef, fakeInst('od-1')],
      ['u2', fakeDef('delay'), fakeInst('dl-1'), true],
    ],
    {
      ampInstance: fakeInst('amp-1'),
      ampInstanceDef: ampDef,
      ampInstanceKey: 'crunch:0',
      cabInstance: fakeInst('cab-1'),
      cabInstanceDef: cabDef,
    },
  );
  const spec = specOf({
    chain: [
      pedal('u1', odDef),
      pedal('u2', prev.instances.get('u2')!.def, { post: true }),
    ],
    amp: ampSpec(ampDef, { key: 'crunch:0' }),
    cab: ampSpec(cabDef),
  });
  const plan = planGraph(spec, prev);

  assert.equal(plan.empty, true);
  assert.deepEqual(plan.dispose, []);
  assert.deepEqual(plan.pedals, []);
  assert.equal(plan.amp, null);
  assert.equal(plan.cab, null);
});

test('仅参数值变化(结构不变)→ 空 plan:参数走 updateParam,不触发重建', () => {
  const odDef = fakeDef('overdrive');
  const prev = prevWithPedals([['u1', odDef, fakeInst('od-1')]]);
  const plan = planGraph(
    specOf({ chain: [pedal('u1', odDef, { values: { level: 99 } })] }),
    prev,
  );
  assert.equal(plan.empty, true);
});

test('重排序/post 翻转 = 结构变化 → 非空 plan(实例仍复用)', () => {
  const defA = fakeDef('overdrive');
  const defB = fakeDef('delay');
  const instA = fakeInst('a');
  const instB = fakeInst('b');
  const prev = prevWithPedals([
    ['u1', defA, instA],
    ['u2', defB, instB],
  ]);
  // 交换顺序
  const reordered = planGraph(
    specOf({ chain: [pedal('u2', defB), pedal('u1', defA)] }),
    prev,
  );
  assert.equal(reordered.empty, false);
  assert.deepEqual(reordered.dispose, []);
  assert.equal(reordered.pedals[0].inst, instB);
  assert.equal(reordered.pedals[1].inst, instA);

  // post 翻转
  const flipped = planGraph(
    specOf({ chain: [pedal('u1', defA), pedal('u2', defB, { post: true })] }),
    prev,
  );
  assert.equal(flipped.empty, false, 'post 翻转改变拓扑,必须重建接线');
  assert.equal(flipped.pedals.find((p) => p.uid === 'u2')?.inst, instB, '实例仍按 uid+def 复用');
});

test('首次建图(prevState.globalBypass=null)即使 spec 全空也非空', () => {
  const prev = emptyPrev({ globalBypass: null });
  const plan = planGraph(specOf(), prev);
  assert.equal(plan.empty, false, '首次必须建图:inputGain → looper/output 的直通接线');
});

// ---------- disabled spec ----------

test('disabled spec 不进接线清单;其存活实例进 dispose', () => {
  const defA = fakeDef('overdrive');
  const defB = fakeDef('delay');
  const instA = fakeInst('a');
  const instB = fakeInst('b');
  const prev = prevWithPedals([
    ['u1', defA, instA],
    ['u2', defB, instB],
  ]);
  const plan = planGraph(
    specOf({ chain: [pedal('u1', defA), pedal('u2', defB, { enabled: false })] }),
    prev,
  );

  assert.equal(plan.empty, false);
  assert.deepEqual(plan.pedals.map((p) => p.uid), ['u1'], 'disabled 单块不接线');
  assert.deepEqual(plan.dispose, [instB], '被关掉的单块实例销毁');
});

test('spec 里的 disabled 单块本来就不占实例:不影响空 plan 判定', () => {
  const defA = fakeDef('overdrive');
  const prev = prevWithPedals([['u1', defA, fakeInst('a')]]);
  const plan = planGraph(
    specOf({
      chain: [pedal('u1', defA), pedal('u9', fakeDef('delay'), { enabled: false })],
    }),
    prev,
  );
  assert.equal(plan.empty, true, '新增 disabled 单块不算结构变化');
});

// ---------- globalBypass ----------

test('globalBypass → 保留复用实例 + 直连计划(不接线、不新建)', () => {
  const odDef = fakeDef('overdrive');
  const ampDef = fakeDef('nam-wasm');
  const cabDef = fakeDef('gb4x12');
  const od = fakeInst('od-1');
  const amp = fakeInst('amp-1');
  const cab = fakeInst('cab-1');
  const prev = prevWithPedals([['u1', odDef, od]], {
    ampInstance: amp,
    ampInstanceDef: ampDef,
    ampInstanceKey: 'nam:1',
    cabInstance: cab,
    cabInstanceDef: cabDef,
    globalBypass: false,
  });
  const plan = planGraph(
    specOf({
      chain: [pedal('u1', odDef)],
      amp: ampSpec(ampDef, { key: 'nam:1' }),
      cab: ampSpec(cabDef),
      globalBypass: true,
    }),
    prev,
  );

  assert.equal(plan.empty, false);
  assert.equal(plan.globalBypass, true);
  assert.equal(plan.pedals.length, 1);
  assert.equal(plan.pedals[0].inst, od, 'bypass 保留单块实例');
  assert.equal(plan.amp?.inst, amp, 'bypass 保留箱头实例(def+key 命中)');
  assert.equal(plan.cab?.inst, cab, 'bypass 保留箱体 Runtime');
  assert.deepEqual(plan.dispose, []);
});

test('bypass 期间新增单块不新建实例;解除 bypass 后才创建', () => {
  const odDef = fakeDef('overdrive');
  const od = fakeInst('od-1');
  const prev = prevWithPedals([['u1', odDef, od]], { globalBypass: true });
  const plan = planGraph(
    specOf({
      chain: [pedal('u1', odDef), pedal('u2', fakeDef('delay'))],
      globalBypass: true,
    }),
    prev,
  );

  assert.equal(plan.empty, false, '链结构变了,bypass 计划也要更新保留清单');
  assert.deepEqual(plan.pedals.map((p) => p.uid), ['u1'], 'bypass 期间不新建实例');
  assert.equal(plan.pedals[0].inst, od);
});

test('bypass 稳态(bypass→bypass)无结构变化 → 空 plan(即使 spec 有箱体)', () => {
  const odDef = fakeDef('overdrive');
  const prev = prevWithPedals([['u1', odDef, fakeInst('a')]], { globalBypass: true });
  const plan = planGraph(
    specOf({
      chain: [pedal('u1', odDef)],
      cab: ampSpec(fakeDef('gb4x12')),
      globalBypass: true,
    }),
    prev,
  );
  assert.equal(plan.empty, true, 'bypass 下箱体恒不存在,不参与结构比对');
});

// ---------- 保留实例的回放参数 ----------

test('保留实例携带 spec 回放参数(新建与复用都回放)', () => {
  const odDef = fakeDef('overdrive');
  const ampDef = fakeDef('crunch');
  const inst = fakeInst('a');
  const amp = fakeInst('amp');
  const prev = prevWithPedals([['u1', odDef, inst]], {
    ampInstance: amp,
    ampInstanceDef: ampDef,
    ampInstanceKey: 'k',
  });
  const plan = planGraph(
    specOf({
      chain: [pedal('u1', odDef, { values: { drive: 7, level: 3 } }), pedal('u2', fakeDef('delay'), { values: { mix: 40 } })],
      amp: ampSpec(ampDef, { key: 'k', values: { gain: 8 } }),
      cab: ampSpec(fakeDef('gb4x12'), { values: { level: -2 } }),
    }),
    prev,
  );

  assert.deepEqual(plan.pedals[0].values, { drive: 7, level: 3 }, '复用实例回放新值');
  assert.deepEqual(plan.pedals[1].values, { mix: 40 }, '新建实例携带初始值');
  assert.deepEqual(plan.amp?.values, { gain: 8 });
  assert.deepEqual(plan.cab?.values, { level: -2 });
});
