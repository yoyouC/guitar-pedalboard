import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRigStore,
  rigFromPreset,
  rigFromShare,
  rigFromSnapshot,
  rigToShareState,
  isSnapshotDirty,
  type RigEngine,
  type RigStoreState,
} from '../src/state/rigStore.ts';
import { decodeShareState, encodeShareState, DEFAULT_RIG_ENCODED } from '../src/state/share.ts';

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
    setChain: rec('setChain'),
    setAmp: rec('setAmp'),
    setCab: rec('setCab'),
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

/** 结构性 verb / applyRig 的固定引擎写序列(结构四连 + 全局两连) */
const STRUCTURE_SEQUENCE = ['setGlobalBypass', 'setChain', 'setAmp', 'setCab'];
const APPLY_SEQUENCE = [...STRUCTURE_SEQUENCE, 'setInputGain', 'setMasterVolume'];

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
    cabEnabled: state.cabEnabled,
    cabValues: state.cabValues,
    inputGain: state.inputGain,
    masterVolume: state.masterVolume,
    globalBypass: state.globalBypass,
  };
}

test.beforeEach(() => {
  installLocalStorage();
});

// ---------- 参数 verb:状态 + 引擎双写,不触发重建 ----------

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

  calls.length = 0;
  store.setAmpEnabled(false);
  assert.equal(store.getState().ampEnabled, false);
  assert.deepEqual(methods(), STRUCTURE_SEQUENCE);
  assert.equal(store.getState().graphVersion, 6);
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

test('snapshot capture/recall/clear with derived dirty flag', () => {
  const { engine, calls } = createStubEngine();
  const store = createRigStore(engine);
  const uid = store.getState().chain[1].uid;

  store.captureSnapshot(0);
  assert.equal(store.getState().activeSlot, 0);
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

test('preset save/load round-trip writes engine with the fixed applyRig sequence', () => {
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
  const result = store.loadPreset('solo');
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls.map((c) => c.method), APPLY_SEQUENCE);
  assert.equal(store.getState().masterVolume, 0.8);
  assert.equal(store.getState().chain.some((i) => i.effectId === 'chorus'), true);

  // 不存在的预设:无操作
  calls.length = 0;
  assert.equal(store.loadPreset('nope').ok, false);
  assert.equal(calls.length, 0);

  store.deletePreset('solo');
  assert.equal(store.getState().presets.length, 0);
});

test('loadPreset migrates legacy chain-only presets', () => {
  const { engine } = createStubEngine();
  const store = createRigStore(engine);
  const legacy = [
    { name: 'old', items: [{ effectId: 'overdrive', enabled: true, values: { drive: 30 } }] },
  ];
  assert.equal(store.importPresets(JSON.stringify(legacy)), 1);

  const result = store.loadPreset('old');
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

test('loadPreset blocks presets requiring a different custom NAM model', () => {
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
  const result = store.loadPreset('needs-nam');
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : (result.message ?? ''), /MyCapture/);
  assert.equal(store.getState().chain, before); // 状态未被触碰
  assert.equal(calls.length, 0); // 引擎未被触碰
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
