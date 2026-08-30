import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRigStore,
  customIrReferenceLabels,
  rigFromPreset,
  rigFromShare,
  rigFromSnapshot,
  rigToShareState,
  toSnapshot,
  isSnapshotDirty,
  referencedCustomIrHashes,
  type RigEngine,
  type RigStoreState,
} from '../src/state/rigStore.ts';
import { decodeShareState, encodeShareState, DEFAULT_RIG_ENCODED } from '../src/state/share.ts';
import { createDefaultPreAmpEqState } from '../src/audio/preAmpEq.ts';

/**
 * rigStore 行为测试:只用 stub engine 断言 store interface 上的外部行为
 * (状态读取 + 引擎收到的调用序列),不断言内部实现。
 */

// ---------- 测试替身 ----------

interface EngineCall {
  method: string;
  args: unknown[];
}

function createStubEngine() {
  const calls: EngineCall[] = [];
  const rec = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
  };
  const engine: RigEngine = {
    setGlobalBypass: rec('setGlobalBypass'),
    applyRig: rec('applyRig'),
    setChain: rec('setChain'),
    setAmp: rec('setAmp'),
    setCab: rec('setCab'),
    setPreAmpEq: rec('setPreAmpEq'),
    setPreAmpEqEnabled: rec('setPreAmpEqEnabled'),
    updatePreAmpEqBand: rec('updatePreAmpEqBand'),
    setPreAmpEqLevel: rec('setPreAmpEqLevel'),
    updateParam: rec('updateParam'),
    updateAmpParam: rec('updateAmpParam'),
    updateCabParam: rec('updateCabParam'),
    setInputGain: rec('setInputGain'),
    setMasterVolume: rec('setMasterVolume'),
  };
  return {
    engine,
    calls,
    methods: () => calls.map((c) => c.method),
  };
}

/** 内存 localStorage(node 环境下 store 的持久化读写目标) */
function installLocalStorage() {
  const map = new Map<string, string>();
  const stub = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: stub,
    configurable: true,
    writable: true,
  });
  return stub;
}

/** 结构性 verb 仍走固定四连；完整 Rig 恢复走单次批量投影。 */
const STRUCTURE_SEQUENCE = ['setGlobalBypass', 'setChain', 'setAmp', 'setCab'];
const CAB_COMMIT_SEQUENCE = [...STRUCTURE_SEQUENCE, 'updateCabParam'];
const APPLY_SEQUENCE = ['applyRig'];

/** 比较用的链摘要(uid 各路径重新生成,不参与比较) */
function chainSummary(state: RigStoreState) {
  return state.chain.map(({ effectId, enabled, values, post }) => ({
    effectId,
    enabled,
    values,
    post,
  }));
}

/** 比较用的 rig 摘要(不含 ampCategoryId/ampModelKeys 等路径相关的簿记字段) */
function rigSummary(state: RigStoreState) {
  return {
    chain: chainSummary(state),
    ampId: state.ampId,
    ampEnabled: state.ampEnabled,
    ampValues: state.ampValues,
    cabId: state.cabId,
    cabIrRef: state.cabIrRef,
    cabEnabled: state.cabEnabled,
    cabValues: state.cabValues,
    preAmpEq: state.preAmpEq,
    inputGain: state.inputGain,
    masterVolume: state.masterVolume,
    globalBypass: state.globalBypass,
  };
}

test.beforeEach(() => {
  installLocalStorage();
});

// ---------- 参数 verb:状态 + 引擎双写,不触发重建 ----------

test('initial state aligns with catalog defaults (ADR-0006 单点)', () => {
  const { engine } = createStubEngine();
  const state = createRigStore(engine).getState();
  // 全局参数与箱体来自 catalog.defaults
  assert.equal(state.inputGain, 1);
  assert.equal(state.masterVolume, 0.5);
  assert.equal(state.globalBypass, false);
  assert.equal(state.cabId, 'gb4x12');
  assert.deepEqual(state.preAmpEq, createDefaultPreAmpEqState());
  // 默认型号(builtin:crunch)推导初始箱头分类与 def
  assert.equal(state.ampCategoryId, 'crunch');
  assert.equal(state.ampId, 'crunch');
  // 每个箱头分类记住该类的第一个型号
  assert.equal(state.ampModelKeys.clean, 'builtin:clean');
  assert.equal(state.ampModelKeys.chime, 'builtin:chime');
  assert.equal(state.ampModelKeys.crunch, 'builtin:crunch');
  assert.equal(state.ampModelKeys.recto, 'builtin:recto');
});

test('param verbs update state and engine without structure rebuild', () => {
  const { engine, calls } = createStubEngine();
  const store = createRigStore(engine);
  const uid = store.getState().chain[1].uid; // overdrive

  store.setPedalParam(uid, 'drive', 55);
  assert.equal(store.getState().chain[1].values.drive, 55);
  assert.deepEqual(calls, [{ method: 'updateParam', args: [uid, 'drive', 55] }]);
  assert.equal(store.getState().graphVersion, 0);

  calls.length = 0;
  store.setAmpParam('gain', 80);
  assert.equal(store.getState().ampValues.gain, 80);
  assert.deepEqual(calls, [{ method: 'updateAmpParam', args: ['gain', 80] }]);

  calls.length = 0;
  store.setCabParam('level', -4);
  assert.equal(store.getState().cabValues.level, -4);
  assert.deepEqual(calls, [{ method: 'updateCabParam', args: ['level', -4] }]);

  calls.length = 0;
  store.setInputGain(1.5);
  store.setMasterVolume(0.7);
  assert.equal(store.getState().inputGain, 1.5);
  assert.equal(store.getState().masterVolume, 0.7);
  assert.deepEqual(calls, [
    { method: 'setInputGain', args: [1.5] },
    { method: 'setMasterVolume', args: [0.7] },
  ]);
  assert.equal(store.getState().graphVersion, 0);
});

test('箱头前均衡 verbs 实时投影且 Reset 保持开关、不触发图谱重建', () => {
  const { engine, calls } = createStubEngine();
  const store = createRigStore(engine);

  store.setPreAmpEqBand('hz1000', 6.24);
  store.setPreAmpEqLevel(-3.26);
  store.setPreAmpEqEnabled(true);
  assert.equal(store.getState().preAmpEq.bands.hz1000, 6);
  assert.equal(store.getState().preAmpEq.levelDb, -3.5);
  assert.equal(store.getState().preAmpEq.enabled, true);
  assert.deepEqual(calls.map((call) => call.method), [
    'updatePreAmpEqBand',
    'setPreAmpEqLevel',
    'setPreAmpEqEnabled',
  ]);
  assert.deepEqual(calls[0].args, ['hz1000', 6]);
  assert.deepEqual(calls[1].args, [-3.5]);
  assert.equal(store.getState().graphVersion, 0);

  calls.length = 0;
  store.resetPreAmpEq();
  assert.equal(store.getState().preAmpEq.enabled, true);
  assert.deepEqual(Object.values(store.getState().preAmpEq.bands), Array(10).fill(0));
  assert.equal(store.getState().preAmpEq.levelDb, 0);
  assert.deepEqual(calls.map((call) => call.method), ['setPreAmpEq']);
  assert.equal(store.getState().graphVersion, 0);
});

test('subscribe notifies listeners on verb calls and unsubscribe works', () => {
  const { engine } = createStubEngine();
  const store = createRigStore(engine);
  let notified = 0;
  const off = store.subscribe(() => notified++);
  store.setMasterVolume(0.9);
  store.addPedal('chorus');
  assert.equal(notified, 2);
  off();
  store.setMasterVolume(0.1);
  assert.equal(notified, 2);
});

// ---------- 结构 verb:触发重建,graphVersion 自增 ----------

test('structural verbs rebuild graph (fixed sequence) and bump graphVersion', () => {
  const { engine, calls, methods } = createStubEngine();
  const store = createRigStore(engine);
  const uid = store.getState().chain[0].uid;

  store.addPedal('delay');
  assert.deepEqual(methods(), STRUCTURE_SEQUENCE);
  assert.equal(store.getState().graphVersion, 1);
  // 引擎收到的箱头 spec:def + 版本 key(复用语义见 AudioEngine.AmpSpec)
  const ampCall = calls.find((c) => c.method === 'setAmp');
  const ampSpec = ampCall!.args[0] as { def: { id: string }; enabled: boolean; key: string };
  assert.equal(ampSpec.def.id, 'crunch');
  assert.equal(ampSpec.enabled, true);
  assert.equal(ampSpec.key, 'crunch:0');

  calls.length = 0;
  store.togglePedal(uid);
  assert.equal(store.getState().chain[0].enabled, false);
  assert.deepEqual(methods(), STRUCTURE_SEQUENCE);
  assert.equal(store.getState().graphVersion, 2);

  calls.length = 0;
  store.removePedal(uid);
  assert.equal(store.getState().chain.some((i) => i.uid === uid), false);
  assert.equal(store.getState().graphVersion, 3);

  calls.length = 0;
  store.setGlobalBypass(true);
  assert.equal(store.getState().globalBypass, true);
  assert.deepEqual(methods(), STRUCTURE_SEQUENCE);
  assert.equal(store.getState().graphVersion, 4);

  calls.length = 0;
  store.setCab('blue2x12');
  assert.equal(store.getState().cabId, 'blue2x12');
  assert.equal(store.getState().graphVersion, 5);
  const cabSpec = calls.find((call) => call.method === 'setCab')!.args[0] as {
    def: { id: string };
    key: string;
    irRef: unknown;
  };
  assert.equal(cabSpec.def.id, 'blue2x12');
  assert.equal(cabSpec.key, 'cab-dsp:blue2x12');
  assert.deepEqual(cabSpec.irRef, { kind: 'builtin', id: 'blue2x12' });

  calls.length = 0;
  store.setAmpEnabled(false);
  assert.equal(store.getState().ampEnabled, false);
  assert.deepEqual(methods(), STRUCTURE_SEQUENCE);
  assert.equal(store.getState().graphVersion, 6);
});

test('custom IR commit stores only its hash and projects the stable IR runtime', () => {
  const { engine, calls, methods } = createStubEngine();
  const store = createRigStore(engine);
  const hash = 'c'.repeat(64);

  store.commitCabIr({ kind: 'custom', hash });

  assert.equal(store.getState().cabId, 'customIr');
  assert.deepEqual(store.getState().cabIrRef, { kind: 'custom', hash });
  assert.equal(store.getState().cabValues.level, -2);
  assert.deepEqual(methods(), CAB_COMMIT_SEQUENCE);
  const cabSpec = calls.find((call) => call.method === 'setCab')?.args[0] as {
    def: { id: string };
    irRef: unknown;
  };
  assert.equal(cabSpec.def.id, 'cabIrRuntime');
  assert.deepEqual(cabSpec.irRef, { kind: 'custom', hash });
  assert.deepEqual(calls.at(-1), { method: 'updateCabParam', args: ['level', -2] });

  store.captureSnapshot(0);
  store.savePreset('Pinned IR');
  assert.deepEqual([...referencedCustomIrHashes(store.getState())], [hash]);
  assert.deepEqual(customIrReferenceLabels(store.getState(), hash), [
    '当前 Rig',
    '预设“Pinned IR”',
    '快照 A',
  ]);
  assert.equal(JSON.stringify(store.getState().presets).includes('Blob'), false);
});

test('addPedal inserts pre effects before the FX Loop partition', () => {
  const { engine } = createStubEngine();
  const store = createRigStore(engine);
  // 默认链:noiseGate/overdrive/volume 前置,delay/reverb 后置
  assert.deepEqual(
    store.getState().chain.map((i) => i.post),
    [false, false, false, true, true],
  );
  store.addPedal('chorus');
  assert.deepEqual(
    store.getState().chain.map((i) => i.effectId),
    ['noiseGate', 'overdrive', 'volume', 'chorus', 'delay', 'reverb'],
  );
  assert.equal(store.getState().chain[3].post, false);
});

test('Tone3000 Pedal add/replace keeps stable uid and projects exact model identity', () => {
  const { engine, calls } = createStubEngine();
  const store = createRigStore(engine);
  const uid = store.addTone3000Pedal('tone3000:42', '9001');
  const added = store.getState().chain.find((item) => item.uid === uid)!;
  assert.deepEqual(
    { effectId: added.effectId, modelRef: added.modelRef, modelId: added.modelId, post: added.post },
    { effectId: 'tone3000Nam', modelRef: 'tone3000:42', modelId: '9001', post: false },
  );
  const firstSpec = calls.findLast((call) => call.method === 'setChain')!.args[0] as Array<{
    uid: string;
    def: { id: string };
    key?: string;
  }>;
  const firstProjected = firstSpec.find((item) => item.uid === uid)!;
  assert.equal(firstProjected.def.id, 'tone3000Nam');
  assert.equal(firstProjected.key, 'tone3000:42:model:9001:runtime:0');

  assert.equal(store.reloadTone3000Pedal(uid), true);
  const reloadedSpec = calls.findLast((call) => call.method === 'setChain')!.args[0] as Array<{
    uid: string;
    key?: string;
  }>;
  assert.equal(
    reloadedSpec.find((item) => item.uid === uid)?.key,
    'tone3000:42:model:9001:runtime:1',
  );
  assert.equal(store.getState().chain.find((item) => item.uid === uid)?.modelRef, 'tone3000:42');

  assert.equal(store.replaceTone3000Pedal(uid, 'tone3000:43', '9002'), true);
  const replaced = store.getState().chain.find((item) => item.uid === uid)!;
  assert.equal(replaced.uid, uid);
  assert.equal(replaced.modelRef, 'tone3000:43');
  assert.equal(replaced.modelId, '9002');
  assert.equal(store.replaceTone3000Pedal('missing', 'tone3000:44'), false);
});

test('Tone3000 public store verbs reject malformed model identities before graph projection', () => {
  const { engine, calls } = createStubEngine();
  const store = createRigStore(engine);
  const beforeChain = store.getState().chain;
  const beforeAmp = store.getState().ampModelKeys.tone3000;
  calls.length = 0;

  assert.throws(() => store.addTone3000Pedal('tone3000:../42'), /id 格式无效/);
  const uid = store.addTone3000Pedal('tone3000:42');
  calls.length = 0;
  assert.equal(store.replaceTone3000Pedal(uid, 'tone3000:43', 'bad-model'), false);
  store.setAmpModel('tone3000', 'tone3000:not-a-number');
  store.setAmpModel('clean', 'tone3000:43');
  store.setAmpModel('tone3000', 'builtin:clean');

  assert.equal(store.getState().chain[0], beforeChain[0]);
  assert.equal(store.getState().chain.find((item) => item.uid === uid)?.modelRef, 'tone3000:42');
  assert.equal(store.getState().ampModelKeys.tone3000, beforeAmp);
  assert.equal(calls.length, 0);
});

test('movePedal across partitions flips post; setPedalPost moves to target partition end', () => {
  const { engine } = createStubEngine();
  const store = createRigStore(engine);
  // 把第 0 块(前置 noiseGate)拖到末尾 → 跨区,翻转为后置
  store.movePedal(0, 4);
  let chain = store.getState().chain;
  assert.equal(chain[4].effectId, 'noiseGate');
  assert.equal(chain[4].post, true);

  // setPedalPost:翻转 post;前置→后置落在 post 分区开头,后置→前置落在 pre 分区末尾
  // (与旧 App.handleToggleSlot 的 splice(boundary) 行为逐字一致)
  const overdrive = chain.find((i) => i.effectId === 'overdrive')!;
  store.setPedalPost(overdrive.uid);
  chain = store.getState().chain;
  assert.deepEqual(
    chain.map((i) => i.effectId),
    ['volume', 'overdrive', 'delay', 'reverb', 'noiseGate'],
  );
  assert.equal(chain[1].post, true);
});

test('setAmp switches the amp def and resets its values', () => {
  const { engine, calls, methods } = createStubEngine();
  const store = createRigStore(engine);
  store.setAmpParam('gain', 99);

  calls.length = 0;
  store.setAmp('recto');
  assert.equal(store.getState().ampId, 'recto');
  assert.equal(store.getState().ampValues.gain, 70); // recto 默认
  assert.deepEqual(methods(), STRUCTURE_SEQUENCE);
  const ampSpec = calls.find((c) => c.method === 'setAmp')!.args[0] as {
    def: { id: string };
    key: string;
  };
  assert.equal(ampSpec.def.id, 'recto');
  assert.equal(ampSpec.key, 'recto:0');
});

test('setAmpModel resets values; NAM kinds bump namVersion, builtin does not', () => {
  const { engine, calls } = createStubEngine();
  const store = createRigStore(engine);
  store.setAmpParam('gain', 99);

  store.setAmpModel('clean', 'builtin:clean');
  assert.equal(store.getState().ampId, 'clean');
  assert.equal(store.getState().ampCategoryId, 'clean');
  assert.equal(store.getState().ampModelKeys.clean, 'builtin:clean');
  assert.equal(store.getState().ampValues.gain, 40); // 回到默认
  assert.equal(store.getState().namVersion, 0);

  calls.length = 0;
  store.setAmpModel('crunch', 'nam-wasm:jcm2000-crunch');
  assert.equal(store.getState().ampId, 'nam-wasm');
  assert.equal(store.getState().namVersion, 1);
  const ampSpec = calls.find((c) => c.method === 'setAmp')!.args[0] as { key: string };
  assert.equal(ampSpec.key, 'nam-wasm:1');

  store.setAmpModel('recto', 'builtin:recto');
  assert.equal(store.getState().namVersion, 1); // builtin 不增
});

// ---------- applyRig:三条恢复路径写引擎序列一致 ----------

/** 搭一份非默认 rig(builtin 箱头,保证快照路径 ampId 可等价),返回三种来源 */
function makeSourceRig() {
  const { engine } = createStubEngine();
  const src = createRigStore(engine);
  src.addPedal('chorus');
  const overdrive = src.getState().chain.find((i) => i.effectId === 'overdrive')!;
  src.togglePedal(overdrive.uid);
  src.setPedalParam(src.getState().chain[0].uid, 'threshold', -40);
  src.setAmpModel('clean', 'builtin:clean');
  src.setAmpParam('gain', 70);
  src.setCab('blue2x12');
  src.setCabParam('level', -4);
  src.setPreAmpEqBand('hz1000', 4);
  src.setPreAmpEqLevel(-2);
  src.setPreAmpEqEnabled(true);
  src.savePreset('T');
  src.captureSnapshot(0);
  const state = src.getState();
  return {
    preset: state.presets.find((p) => p.name === 'T')!,
    snapshot: state.snapshots[0]!,
    share: decodeShareState(encodeShareState(rigToShareState(state)))!,
  };
}

test('applyRig writes the same engine call sequence for preset/snapshot/share sources', () => {
  const { preset, snapshot, share } = makeSourceRig();

  const viaPreset = createStubEngine();
  const storeP = createRigStore(viaPreset.engine);
  storeP.applyRig(rigFromPreset(preset));

  const viaSnapshot = createStubEngine();
  const storeS = createRigStore(viaSnapshot.engine);
  storeS.applyRig(rigFromSnapshot(snapshot));

  const viaShare = createStubEngine();
  const storeH = createRigStore(viaShare.engine);
  storeH.applyRig(rigFromShare(share));

  assert.deepEqual(viaPreset.methods(), APPLY_SEQUENCE);
  assert.deepEqual(viaSnapshot.methods(), APPLY_SEQUENCE);
  assert.deepEqual(viaShare.methods(), APPLY_SEQUENCE);

  assert.deepEqual(rigSummary(storeS.getState()), rigSummary(storeP.getState()));
  assert.deepEqual(rigSummary(storeH.getState()), rigSummary(storeP.getState()));
});

test('createRigStore applies initialRig at construction (factory default share path)', () => {
  const share = decodeShareState(DEFAULT_RIG_ENCODED)!;
  const { engine, methods } = createStubEngine();
  const store = createRigStore(engine, { initialRig: rigFromShare(share) });
  assert.deepEqual(methods(), APPLY_SEQUENCE);
  const state = store.getState();
  // 出厂配置:JCM800 扫档包 NAM 箱头(namVersion 自增 → 引擎 key 换代)
  assert.equal(state.ampId, 'nam-wasm');
  assert.equal(state.namVersion, 1);
  assert.equal(state.ampModelKeys.crunch, 'nam-wasm-pack:jcm800-sweep');
  assert.deepEqual(
    state.chain.map((i) => i.effectId),
    ['dynacomp', 'klonwdf', 'analogdelay', 'springreverb'],
  );
});

// ---------- 快照:capture/recall/clear + dirty 派生 ----------

test('derivation: toSnapshot/rigToShareState are canonical minus the agreed fields', () => {
  // 同一状态:savePreset(canonical 全量)与 toSnapshot(− globals)、
  // rigToShareState(− globals − customName)的 chain/amp/cab 完全一致——
  // 派生是显式减法,不是各自维护的形状(ADR-0006)
  const { engine } = createStubEngine();
  const store = createRigStore(engine);
  store.addPedal('chorus');
  store.setAmpModel('crunch', 'nam-wasm-pack:jcm800-sweep');
  store.setAmpParam('gain', 66);
  store.savePreset('P');
  const state = store.getState();
  const preset = state.presets.find((p) => p.name === 'P')!;

  // snapshot = preset.rig − globals(customName 不在快照形状里,型号引用一致)
  const snap = toSnapshot(state);
  assert.deepEqual(snap.chain, preset.rig.chain);
  assert.deepEqual(snap.amp, {
    categoryId: preset.rig.amp.categoryId,
    modelKey: preset.rig.amp.modelKey,
    enabled: preset.rig.amp.enabled,
    values: preset.rig.amp.values,
  });
  assert.deepEqual(snap.cab, preset.rig.cab);
  assert.deepEqual(snap.preAmpEq, preset.rig.preAmpEq);
  assert.equal('globals' in snap, false);

  // share = preset.rig − globals − customName(扁平化是编码层的形状,不是第三套知识)
  const share = rigToShareState(state);
  assert.deepEqual(
    share.chain.map(({ effectId, enabled, values, post }) => ({ effectId, enabled, values, post })),
    preset.rig.chain,
  );
  assert.equal(share.ampCategoryId, preset.rig.amp.categoryId);
  assert.equal(share.ampModelKey, preset.rig.amp.modelKey);
  assert.deepEqual(share.ampValues, preset.rig.amp.values);
  assert.equal(share.cabId, preset.rig.cab.id);
  assert.deepEqual(share.cabIrRef, preset.rig.cab.ir);
  assert.deepEqual(share.cabValues, preset.rig.cab.values);
  assert.deepEqual(share.preAmpEq, preset.rig.preAmpEq);
});

test('snapshot capture/recall/clear with derived dirty flag', () => {
  const { engine, calls } = createStubEngine();
  const store = createRigStore(engine);
  const uid = store.getState().chain[1].uid;

  store.captureSnapshot(0);
  assert.equal(store.getState().activeSlot, 0);
  assert.equal(isSnapshotDirty(store.getState(), 0), false);
  store.setPreAmpEqBand('hz2000', 3);
  assert.equal(isSnapshotDirty(store.getState(), 0), true, 'EQ 参数属于 Snapshot dirty');
  store.setPreAmpEqBand('hz2000', 0);
  assert.equal(isSnapshotDirty(store.getState(), 0), false);
  store.setPreAmpEqLevel(-2);
  assert.equal(isSnapshotDirty(store.getState(), 0), true, 'EQ Level 属于 Snapshot dirty');
  store.setPreAmpEqLevel(0);
  assert.equal(isSnapshotDirty(store.getState(), 0), false);
  store.setPreAmpEqEnabled(true);
  assert.equal(isSnapshotDirty(store.getState(), 0), true, 'EQ 开关属于 Snapshot dirty');
  store.setPreAmpEqEnabled(false);
  assert.equal(isSnapshotDirty(store.getState(), 0), false);
  // 持久化:新 store 能读到同一快照
  assert.notEqual(createRigStore(createStubEngine().engine).getState().snapshots[0], null);

  store.setPedalParam(uid, 'drive', 55);
  assert.equal(isSnapshotDirty(store.getState(), 0), true);
  assert.equal(isSnapshotDirty(store.getState(), 1), false); // 非激活槽不 dirty

  calls.length = 0;
  store.recallSnapshot(0);
  assert.equal(
    store.getState().chain[1].values.drive,
    store.getState().snapshots[0]!.chain[1].values.drive,
  );
  assert.equal(isSnapshotDirty(store.getState(), 0), false);
  assert.deepEqual(calls.map((c) => c.method), APPLY_SEQUENCE);

  store.clearSnapshot(0);
  assert.equal(store.getState().snapshots[0], null);
  assert.equal(store.getState().activeSlot, -1);

  // 空槽 recall 是无操作
  calls.length = 0;
  store.recallSnapshot(0);
  assert.equal(calls.length, 0);
  assert.equal(store.getState().activeSlot, -1);
});

// ---------- 预设:保存/加载/删除/导入导出 + 遗留迁移 ----------

test('preset save/load round-trip writes engine with the fixed applyRig sequence', async () => {
  const { engine, calls } = createStubEngine();
  const store = createRigStore(engine);
  store.setMasterVolume(0.8);
  store.addPedal('chorus');
  store.savePreset('solo');

  // 持久化:新 store 启动即读到
  assert.equal(createRigStore(createStubEngine().engine).getState().presets.length, 1);

  store.setMasterVolume(0.2);
  store.removePedal(store.getState().chain.find((i) => i.effectId === 'chorus')!.uid);

  calls.length = 0;
  const result = await store.loadPreset('solo');
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls.map((c) => c.method), APPLY_SEQUENCE);
  assert.equal(store.getState().masterVolume, 0.8);
  assert.equal(store.getState().chain.some((i) => i.effectId === 'chorus'), true);

  // 不存在的预设:无操作
  calls.length = 0;
  assert.equal((await store.loadPreset('nope')).ok, false);
  assert.equal(calls.length, 0);

  store.deletePreset('solo');
  assert.equal(store.getState().presets.length, 0);
});

test('loadPreset migrates legacy chain-only presets', async () => {
  const { engine } = createStubEngine();
  const store = createRigStore(engine);
  const legacy = [
    { name: 'old', items: [{ effectId: 'overdrive', enabled: true, values: { drive: 30 } }] },
  ];
  assert.equal(store.importPresets(JSON.stringify(legacy)), 1);

  const result = await store.loadPreset('old');
  assert.equal(result.ok, true);
  const state = store.getState();
  assert.deepEqual(
    state.chain.map((i) => i.effectId),
    ['overdrive'],
  );
  assert.equal(state.chain[0].values.drive, 30);
  assert.equal(state.chain[0].values.tone, 3000); // 未存的参数回退默认
  assert.equal(state.ampId, 'crunch'); // 目录默认箱头
});

test('loadPreset blocks presets requiring a different custom NAM model', async () => {
  const { engine, calls } = createStubEngine();
  const store = createRigStore(engine);
  const customNam = [
    {
      version: 2,
      name: 'needs-nam',
      rig: {
        chain: [],
        amp: {
          categoryId: 'crunch',
          modelKey: 'nam-wasm:custom',
          enabled: true,
          values: {},
          customName: 'MyCapture',
        },
        cab: { id: 'gb4x12', enabled: true, values: {} },
        globals: { inputGain: 1, masterVolume: 0.5, bypass: false },
      },
    },
  ];
  store.importPresets(JSON.stringify(customNam));

  const before = store.getState().chain;
  const result = await store.loadPreset('needs-nam');
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : (result.message ?? ''), /MyCapture/);
  assert.equal(store.getState().chain, before); // 状态未被触碰
  assert.equal(calls.length, 0); // 引擎未被触碰
});

test('preset restore does not mutate canonical rig until async IR preparation commits', async () => {
  const { engine, calls } = createStubEngine();
  const store = createRigStore(engine);
  store.setCab('blue2x12');
  store.savePreset('blue');
  store.setCab('gb4x12');
  calls.length = 0;

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  store.setRigRestoreHandler(async (_rig, commit) => {
    await gate;
    commit();
    return { ok: true };
  });

  const pending = store.loadPreset('blue');
  assert.equal(store.getState().cabId, 'gb4x12');
  assert.equal(calls.length, 0);
  release();
  assert.deepEqual(await pending, { ok: true });
  assert.equal(store.getState().cabId, 'blue2x12');
  assert.deepEqual(calls.map((call) => call.method), APPLY_SEQUENCE);
});

test('snapshot recall restores NAM model via model mechanism (modelKey round-trip)', () => {
  const { engine } = createStubEngine();
  const store = createRigStore(engine);
  store.setAmpModel('crunch', 'nam-wasm-pack:jcm800-sweep');
  store.setAmpParam('gain', 64);
  store.captureSnapshot(0);
  assert.equal(store.getState().namVersion, 1);

  // 切走:换成别的分类别的箱头
  store.setAmpModel('clean', 'builtin:clean');
  assert.equal(store.getState().ampId, 'clean');
  assert.equal(store.getState().ampCategoryId, 'clean');

  // recall:型号机制恢复 NAM 模型(修复"快照记得箱头忘了模型")
  store.recallSnapshot(0);
  const state = store.getState();
  assert.equal(state.ampCategoryId, 'crunch');
  assert.equal(state.ampModelKeys.crunch, 'nam-wasm-pack:jcm800-sweep');
  assert.equal(state.ampId, 'nam-wasm');
  assert.equal(state.ampValues.gain, 64);
  assert.equal(state.namVersion, 2); // NAM 型号再次换代
});

test('legacy snapshot recall bypasses model mechanism (back-compat)', () => {
  // 旧形状持久化数据(扁平 ampId-only):recall 保持旧行为——
  // 应用 ampId/参数,但不触碰 ampCategoryId/ampModelKeys/namVersion
  localStorage.setItem(
    'guitar-pedalboard-snapshots',
    JSON.stringify([
      {
        chain: [],
        ampId: 'clean',
        ampEnabled: true,
        ampValues: { gain: 70 },
        cabId: 'gb4x12',
        cabEnabled: true,
        cabValues: { level: -13.5 },
      },
    ]),
  );
  const { engine } = createStubEngine();
  const store = createRigStore(engine);
  const before = store.getState();
  assert.equal(before.ampCategoryId, 'crunch');

  store.recallSnapshot(0);
  const state = store.getState();
  assert.equal(state.ampId, 'clean'); // ampId 被应用
  assert.equal(state.ampValues.gain, 70);
  assert.equal(state.ampCategoryId, before.ampCategoryId); // 型号簿记不动
  assert.deepEqual(state.ampModelKeys, before.ampModelKeys);
  assert.equal(state.namVersion, 0); // NAM 全局态不动
});

test('setNamCustomModel records the custom model without touching amp values', () => {
  const { engine } = createStubEngine();
  const store = createRigStore(engine);
  store.setAmpModel('crunch', 'nam-wasm:jcm2000-crunch');
  store.setAmpParam('gain', 66);
  const valuesBefore = store.getState().ampValues;

  store.setNamCustomModel('MyCapture');
  const state = store.getState();
  assert.equal(state.namCustomName, 'MyCapture');
  assert.equal(state.ampModelKeys.crunch, 'nam-wasm:custom');
  assert.equal(state.namVersion, 2);
  assert.equal(state.ampValues, valuesBefore); // 参数不重置
});

// ---------- tone3000 型号 kind + 引擎侧模型源收编(issue #12) ----------

test('setAmpModel tone3000: 走 nam-wasm def,选择收编进 state.namModel', () => {
  const { engine, calls } = createStubEngine();
  const store = createRigStore(engine);
  store.setAmpModel('tone3000', 'tone3000:79103');
  const state = store.getState();
  assert.equal(state.ampId, 'nam-wasm');
  assert.equal(state.ampCategoryId, 'tone3000');
  assert.equal(state.ampModelKeys.tone3000, 'tone3000:79103');
  assert.equal(state.namVersion, 1);
  assert.deepEqual(state.namModel, { source: 'tone3000:79103' });
  // AmpSpec.def 来自选择感知的 memoized 工厂(非注册表静态 def)
  const ampSpec = calls.find((c) => c.method === 'setAmp')!.args[0] as {
    def: { id: string };
    key: string;
  };
  assert.equal(ampSpec.def.id, 'nam-wasm');
});

test('Tone3000 Amp exact modelId survives state, Snapshot and Share projection', () => {
  const { engine } = createStubEngine();
  const store = createRigStore(engine);
  store.setAmpModel('tone3000', 'tone3000:79103', '88001');
  const state = store.getState();
  assert.equal(state.ampTone3000ModelId, '88001');
  assert.deepEqual(state.namModel, { source: 'tone3000:79103', modelId: '88001' });
  assert.equal((toSnapshot(state).amp as { modelId?: string }).modelId, '88001');
  assert.equal(rigToShareState(state).ampModelId, '88001');
});

test('nam def memoization: 同一选择同一 def 实例(复用语义),换选择换 def', () => {
  const { engine, calls } = createStubEngine();
  const store = createRigStore(engine);
  store.setAmpModel('crunch', 'nam-wasm-pack:jcm800-sweep');
  const defA = (calls.findLast((c) => c.method === 'setAmp')!.args[0] as { def: unknown }).def;
  assert.ok('pack' in store.getState().namModel);
  // 无结构参数变化(不动模型)再次触发结构同步 → 同一 def 实例
  store.addPedal('chorus');
  const defA2 = (calls.findLast((c) => c.method === 'setAmp')!.args[0] as { def: unknown }).def;
  assert.equal(defA2, defA);
  // 换模型 → 不同 def 实例
  store.setAmpModel('crunch', 'nam-wasm:jcm2000-crunch');
  const defB = (calls.findLast((c) => c.method === 'setAmp')!.args[0] as { def: unknown }).def;
  assert.notEqual(defB, defA);
});

test('sweep pack selection is captured as data, not module global', () => {
  const { engine } = createStubEngine();
  const store = createRigStore(engine);
  store.setAmpModel('crunch', 'nam-wasm-pack:jcm800-sweep');
  const namModel = store.getState().namModel;
  assert.ok('pack' in namModel);
  if ('pack' in namModel) assert.equal(namModel.pack.id, 'jcm800-sweep');
});

test('custom .nam file: setNamCustomModel 收编 file 选择;applyRig custom 保持当前选择', () => {
  const { engine } = createStubEngine();
  const store = createRigStore(engine);
  store.setAmpModel('crunch', 'nam-wasm:jcm2000-crunch');
  store.setNamCustomModel('MyCapture', 'file:mycap.nam:1234:1');
  assert.deepEqual(store.getState().namModel, { source: 'file:mycap.nam:1234:1' });
  assert.equal(store.getState().ampModelKeys.crunch, 'nam-wasm:custom');
  // 快照 recall(nam-wasm:custom)→ 保持当前 file 选择(已知限制:不跨会话恢复)
  store.captureSnapshot(0);
  store.setAmpModel('clean', 'builtin:clean');
  store.recallSnapshot(0);
  assert.deepEqual(store.getState().namModel, { source: 'file:mycap.nam:1234:1' });
});

test('tone3000 model reference round-trips through preset save/load', async () => {
  const { engine } = createStubEngine();
  const store = createRigStore(engine);
  store.setAmpModel('tone3000', 'tone3000:79103');
  store.savePreset('t3k-preset');
  store.setAmpModel('clean', 'builtin:clean');
  const result = await store.loadPreset('t3k-preset');
  assert.equal(result.ok, true);
  const state = store.getState();
  assert.equal(state.ampCategoryId, 'tone3000');
  assert.equal(state.ampModelKeys.tone3000, 'tone3000:79103');
  assert.deepEqual(state.namModel, { source: 'tone3000:79103' });
});

test('setAmpCategory: 纯视图切换(空分类不扰动当前箱头与引擎)', () => {
  const { engine, calls } = createStubEngine();
  const store = createRigStore(engine);
  const ampBefore = store.getState().ampId;
  const valuesBefore = store.getState().ampValues;
  calls.length = 0;

  store.setAmpCategory('tone3000');
  const state = store.getState();
  assert.equal(state.ampCategoryId, 'tone3000');
  assert.equal(state.ampId, ampBefore);
  assert.equal(state.ampValues, valuesBefore);
  assert.equal(calls.length, 0); // 引擎未被触碰
  assert.equal(state.graphVersion, 0);
});

// ---------- tone3000 非阻断降级(issue #14) ----------

test('degradation: 编排器报告未登录 → 箱头回退默认,引用与 rig 其余保留', () => {
  const { engine } = createStubEngine();
  const store = createRigStore(engine);
  store.addPedal('chorus');
  store.setCab('blue2x12');
  store.setMasterVolume(0.8);

    store.setAmpModel('tone3000', 'tone3000:79103');
    assert.equal(store.getState().ampId, 'nam-wasm'); // 乐观应用
    assert.equal(store.demoteTone3000Amp('tone3000:79103'), true);

    const state = store.getState();
    assert.equal(state.ampId, 'crunch'); // 回退目录默认箱头
    // 引用保留(降级不写入持久化的前提)
    assert.equal(state.ampCategoryId, 'tone3000');
    assert.equal(state.ampModelKeys.tone3000, 'tone3000:79103');
    // rig 其余部分不受影响
    assert.equal(state.chain.some((i) => i.effectId === 'chorus'), true);
    assert.equal(state.cabId, 'blue2x12');
    assert.equal(state.masterVolume, 0.8);
});

test('degradation: runtime 重载恢复 NAM 箱头且保留用户参数', () => {
    const { engine } = createStubEngine();
    const store = createRigStore(engine);
    store.setAmpModel('tone3000', 'tone3000:79001', '88001');
    store.setAmpParam('gain', 37);
    store.demoteTone3000Amp('tone3000:79001');
    assert.equal(store.getState().ampId, 'crunch');

    assert.equal(store.reloadTone3000Amp('tone3000:79001', '88001'), true);
    const state = store.getState();
    assert.equal(state.ampId, 'nam-wasm');
    assert.equal(state.ampValues.gain, 37);
    assert.equal(state.ampTone3000ModelId, '88001');
    assert.deepEqual(state.namModel, { source: 'tone3000:79001', modelId: '88001' });
  });

test('degradation: tone 失效(被删/转私有)→ 回退默认且保留引用', () => {
    const { engine } = createStubEngine();
    const store = createRigStore(engine);
    store.setAmpModel('tone3000', 'tone3000:99999');
    store.demoteTone3000Amp('tone3000:99999');
    const state = store.getState();
    assert.equal(state.ampId, 'crunch');
  });

test('degradation: 选择后在编排器确认失败前保持乐观 NAM 状态', () => {
    const { engine } = createStubEngine();
    const store = createRigStore(engine);
    store.setAmpModel('tone3000', 'tone3000:79103');
    const state = store.getState();
    assert.equal(state.ampId, 'nam-wasm');
  });

test('degradation: 编排器失败到达前用户已切走 → 不降级', () => {
    const { engine } = createStubEngine();
    const store = createRigStore(engine);
    store.setAmpModel('tone3000', 'tone3000:79103');
    store.setAmpModel('clean', 'builtin:clean');
    assert.equal(store.demoteTone3000Amp('tone3000:79103'), false);
    const state = store.getState();
    assert.equal(state.ampId, 'clean');
  });

test('degradation: 降级后 savePreset 仍保存原 tone3000 引用(不写入持久化)', () => {
    const { engine } = createStubEngine();
    const store = createRigStore(engine);
    store.setAmpModel('tone3000', 'tone3000:79103');
    store.demoteTone3000Amp('tone3000:79103');
    store.savePreset('degraded');
    const preset = store.getState().presets.find((p) => p.name === 'degraded')!;
    assert.equal(preset.rig.amp.categoryId, 'tone3000');
    assert.equal(preset.rig.amp.modelKey, 'tone3000:79103');
  });

test('degradation: 编排器重试成功 → NAM 运行实例恢复', () => {
  const { engine } = createStubEngine();
  const store = createRigStore(engine);
  store.setAmpModel('tone3000', 'tone3000:777');
  store.demoteTone3000Amp('tone3000:777');
  assert.equal(store.reloadTone3000Amp('tone3000:777'), true);
  assert.equal(store.getState().ampId, 'nam-wasm');
});
