import assert from 'node:assert/strict';
import test from 'node:test';
import type { ParsedMidiMessage } from '../src/midi/midiMessage.ts';
import type { MidiBinding, MidiTarget } from '../src/midi/midiLearn.ts';
import { LEVEL_DB_MAX, LEVEL_DB_MIN } from '../src/audio/level.ts';
import {
  createBindingTranslator,
  resolveKeyAction,
  translateBinding,
  type KeyStroke,
} from '../src/midi/rigAction.ts';
import { createRigDispatcher } from '../src/midi/rigDispatcher.ts';
import { createRigStore, type RigEngine } from '../src/state/rigStore.ts';

/**
 * 翻译层(issue #8 seam ①):Learn 绑定命中时
 * target(地址)+ 原始消息 + 上一条值 + 链快照 → RigAction|null。
 * 沿检测(CC 上升沿)与值映射(0..127 → 参数范围)的全仓唯一实现。
 */

const cc = (number: number, value: number): ParsedMidiMessage => ({
  type: 'cc',
  channel: 1,
  number,
  value,
  on: false,
});
const noteOn = (number: number, velocity = 100): ParsedMidiMessage => ({
  type: 'note',
  channel: 1,
  number,
  value: velocity,
  on: true,
});
const noteOff = (number: number): ParsedMidiMessage => ({
  type: 'note',
  channel: 1,
  number,
  value: 0,
  on: false,
});

// ---------- 各 target kind 的翻译 ----------

test('pedal-toggle:note 按下 → toggle-pedal(链索引原样携带)', () => {
  const { action } = translateBinding({ kind: 'pedal-toggle', index: 2 }, noteOn(36), 0, []);
  assert.deepEqual(action, { type: 'toggle-pedal', index: 2 });
});

test('snapshot / bypass:note 按下 → recall-snapshot / toggle-bypass', () => {
  assert.deepEqual(
    translateBinding({ kind: 'snapshot', slot: 2 }, noteOn(46), 0, []).action,
    { type: 'recall-snapshot', slot: 2 },
  );
  assert.deepEqual(translateBinding({ kind: 'bypass' }, noteOn(51), 0, []).action, {
    type: 'toggle-bypass',
  });
});

test('looper 三种:record / play / clear', () => {
  assert.deepEqual(translateBinding({ kind: 'looper-record' }, noteOn(60), 0, []).action, {
    type: 'looper-record',
  });
  assert.deepEqual(translateBinding({ kind: 'looper-play' }, noteOn(60), 0, []).action, {
    type: 'looper-toggle-play',
  });
  assert.deepEqual(translateBinding({ kind: 'looper-clear' }, noteOn(60), 0, []).action, {
    type: 'looper-clear',
  });
});

test('master-volume:CC 0 → 0,CC 127 → 1(线性)', () => {
  assert.deepEqual(translateBinding({ kind: 'master-volume' }, cc(7, 0), 0, []).action, {
    type: 'set-master-volume',
    value: 0,
  });
  assert.deepEqual(translateBinding({ kind: 'master-volume' }, cc(7, 127), 0, []).action, {
    type: 'set-master-volume',
    value: 1,
  });
});

test('箱头前均衡 Learn:开关走沿检测，频段与 Level 映射到 ±12 dB', () => {
  assert.deepEqual(
    translateBinding({ kind: 'preamp-eq-toggle' }, noteOn(40), 0, []).action,
    { type: 'toggle-preamp-eq' },
  );
  assert.deepEqual(
    translateBinding({ kind: 'preamp-eq-band', key: 'hz1000' }, cc(12, 0), 0, []).action,
    { type: 'set-preamp-eq-band', key: 'hz1000', value: -12 },
  );
  assert.deepEqual(
    translateBinding({ kind: 'preamp-eq-level' }, cc(13, 127), 0, []).action,
    { type: 'set-preamp-eq-level', value: 12 },
  );
});

test('amp-param:音色 0..100;master 走 dB 范围 LEVEL_DB_MIN..MAX', () => {
  assert.deepEqual(translateBinding({ kind: 'amp-param', key: 'gain' }, cc(2, 127), 0, []).action, {
    type: 'set-amp-param',
    key: 'gain',
    value: 100,
  });
  assert.deepEqual(
    translateBinding({ kind: 'amp-param', key: 'master' }, cc(8, 0), 0, []).action,
    { type: 'set-amp-param', key: 'master', value: LEVEL_DB_MIN },
  );
  assert.deepEqual(
    translateBinding({ kind: 'amp-param', key: 'master' }, cc(8, 127), 0, []).action,
    { type: 'set-amp-param', key: 'master', value: LEVEL_DB_MAX },
  );
});

test('pedal-treadle:CC 值 → position 0..100', () => {
  assert.deepEqual(translateBinding({ kind: 'pedal-treadle', index: 1 }, cc(11, 0), 0, []).action, {
    type: 'set-pedal-treadle',
    index: 1,
    value: 0,
  });
  assert.deepEqual(
    translateBinding({ kind: 'pedal-treadle', index: 1 }, cc(11, 127), 0, []).action,
    { type: 'set-pedal-treadle', index: 1, value: 100 },
  );
});

test('pedal-param:经效果定义参数表映射(overdrive tone 500..8000)', () => {
  const chain = [{ effectId: 'overdrive' }];
  assert.deepEqual(
    translateBinding({ kind: 'pedal-param', index: 0, key: 'tone' }, cc(1, 0), 0, chain).action,
    { type: 'set-pedal-param', index: 0, key: 'tone', value: 500 },
  );
  assert.deepEqual(
    translateBinding({ kind: 'pedal-param', index: 0, key: 'tone' }, cc(1, 127), 0, chain).action,
    { type: 'set-pedal-param', index: 0, key: 'tone', value: 8000 },
  );
});

test('pedal-param:链上无此块 / 无此参数 → 不产生 action', () => {
  assert.equal(
    translateBinding({ kind: 'pedal-param', index: 3, key: 'tone' }, cc(1, 64), 0, []).action,
    null,
  );
  assert.equal(
    translateBinding({ kind: 'pedal-param', index: 0, key: 'nope' }, cc(1, 64), 0, [
      { effectId: 'overdrive' },
    ]).action,
    null,
  );
});

// ---------- CC 上升沿(toggle 类) ----------

test('toggle 类 CC:0 → 正值(>63)触发一次', () => {
  const t: MidiTarget = { kind: 'bypass' };
  const first = translateBinding(t, cc(20, 127), 0, []);
  assert.deepEqual(first.action, { type: 'toggle-bypass' });
  assert.equal(first.nextValue, 127);
});

test('toggle 类 CC:正 → 正不重复触发;阈值 63/64', () => {
  const t: MidiTarget = { kind: 'bypass' };
  assert.equal(translateBinding(t, cc(20, 100), 127, []).action, null);
  assert.equal(translateBinding(t, cc(20, 63), 0, []).action, null);
  assert.deepEqual(translateBinding(t, cc(20, 64), 0, []).action, { type: 'toggle-bypass' });
});

test('toggle 类 CC:回 0 后重新武装,再次上升沿可触发', () => {
  const t: MidiTarget = { kind: 'bypass' };
  const released = translateBinding(t, cc(20, 0), 127, []);
  assert.equal(released.action, null);
  assert.equal(released.nextValue, 0);
  assert.deepEqual(translateBinding(t, cc(20, 127), released.nextValue, []).action, {
    type: 'toggle-bypass',
  });
});

test('连续型 CC 无沿检测:任意值都产生 action', () => {
  const t: MidiTarget = { kind: 'master-volume' };
  for (const v of [0, 1, 63, 64, 127]) {
    const { action } = translateBinding(t, cc(7, v), v, []);
    assert.deepEqual(action, { type: 'set-master-volume', value: v / 127 });
  }
});

// ---------- Note Off ----------

test('Note Off 不产生 action(toggle 与连续型都忽略)', () => {
  assert.equal(translateBinding({ kind: 'bypass' }, noteOff(51), 0, []).action, null);
  assert.equal(translateBinding({ kind: 'master-volume' }, noteOff(7), 0, []).action, null);
});

// ---------- 有状态包装:per-binding 上一条值由工厂持有 ----------

test('createBindingTranslator:跨消息记忆上一条值,上升沿只触发一次', () => {
  const translate = createBindingTranslator();
  const binding: MidiBinding = {
    msgType: 'cc',
    number: 20,
    source: 'other',
    target: { kind: 'pedal-toggle', index: 0 },
  };
  assert.deepEqual(translate(binding, cc(20, 127), []), { type: 'toggle-pedal', index: 0 });
  assert.equal(translate(binding, cc(20, 127), []), null); // 未回 0,不重复触发
  assert.equal(translate(binding, cc(20, 0), []), null); // 释放,重新武装
  assert.deepEqual(translate(binding, cc(20, 127), []), { type: 'toggle-pedal', index: 0 });
});

test('createBindingTranslator:不同绑定的沿状态互相独立', () => {
  const translate = createBindingTranslator();
  const a: MidiBinding = { msgType: 'cc', number: 20, source: 'other', target: { kind: 'bypass' } };
  const b: MidiBinding = {
    msgType: 'cc',
    number: 21,
    source: 'other',
    target: { kind: 'snapshot', slot: 1 },
  };
  translate(a, cc(20, 127), []);
  assert.deepEqual(translate(b, cc(21, 127), []), { type: 'recall-snapshot', slot: 1 });
  assert.equal(translate(a, cc(20, 127), []), null);
  assert.equal(translate(b, cc(21, 127), []), null);
});

// ---------- 键盘 → RigAction(映射表从原 App 键盘 handler 平移) ----------

const key = (code: string, k: string, over: Partial<KeyStroke> = {}): KeyStroke => ({
  code,
  key: k,
  repeat: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  editing: false,
  ...over,
});

test('键盘:空格 → toggle-bypass', () => {
  assert.deepEqual(resolveKeyAction(key('Space', ' ')), { type: 'toggle-bypass' });
});

test('键盘:Q/W/E/R → 快照 A/B/C/D', () => {
  for (const [code, slot] of [
    ['KeyQ', 0],
    ['KeyW', 1],
    ['KeyE', 2],
    ['KeyR', 3],
  ] as const) {
    assert.deepEqual(resolveKeyAction(key(code, code.slice(-1).toLowerCase())), {
      type: 'recall-snapshot',
      slot,
    });
  }
});

test('键盘:数字键 1..9 → 切换链上第 1..9 块单块', () => {
  for (let n = 1; n <= 9; n++) {
    assert.deepEqual(resolveKeyAction(key(`Digit${n}`, String(n))), {
      type: 'toggle-pedal',
      index: n - 1,
    });
  }
});

test('键盘:repeat / 修饰键 / 输入控件聚焦 / 未映射键 → null', () => {
  assert.equal(resolveKeyAction(key('Space', ' ', { repeat: true })), null);
  assert.equal(resolveKeyAction(key('Space', ' ', { ctrlKey: true })), null);
  assert.equal(resolveKeyAction(key('Space', ' ', { metaKey: true })), null);
  assert.equal(resolveKeyAction(key('Space', ' ', { altKey: true })), null);
  assert.equal(resolveKeyAction(key('Space', ' ', { editing: true })), null);
  assert.equal(resolveKeyAction(key('KeyA', 'a')), null);
  assert.equal(resolveKeyAction(key('Digit0', '0')), null);
});

// ---------- dispatch(issue #8 seam ②):action 到达 → rigStore verb 被调 ----------

/** 内存 localStorage(rigStore 构造时读快照/预设) */
function installLocalStorage(): void {
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, String(v)),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
    },
    configurable: true,
    writable: true,
  });
}

interface EngineCall {
  method: string;
  args: unknown[];
}

function setup() {
  installLocalStorage();
  const engineCalls: EngineCall[] = [];
  const rec = (method: string) => (...args: unknown[]) => {
    engineCalls.push({ method, args });
  };
  const engine: RigEngine = {
    setGlobalBypass: rec('setGlobalBypass'),
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
  const store = createRigStore(engine);
  const looperCalls: string[] = [];
  const dispatch = createRigDispatcher({
    store,
    looper: {
      primary: () => looperCalls.push('primary'),
      togglePlay: () => looperCalls.push('togglePlay'),
      clear: () => looperCalls.push('clear'),
    },
  });
  return { store, engineCalls, looperCalls, dispatch };
}

test('dispatch toggle-pedal:翻转链上第 index 块(链索引 → uid 解析在此层)', () => {
  const { store, dispatch } = setup();
  const before = store.getState().chain[0].enabled;
  dispatch({ type: 'toggle-pedal', index: 0 });
  assert.equal(store.getState().chain[0].enabled, !before);
  // 越界 index:无动作不报错
  const snapshot = JSON.stringify(store.getState().chain);
  dispatch({ type: 'toggle-pedal', index: 99 });
  assert.equal(JSON.stringify(store.getState().chain), snapshot);
});

test('dispatch set-pedal-enabled:绝对设置第 index 块开关', () => {
  const { store, dispatch } = setup();
  dispatch({ type: 'set-pedal-enabled', index: 1, enabled: false });
  assert.equal(store.getState().chain[1].enabled, false);
});

test('dispatch recall-snapshot:召回快照(slot 无快照时为空转)', () => {
  const { store, dispatch } = setup();
  store.captureSnapshot(0);
  const enabledAtCapture = store.getState().chain[0].enabled;
  store.togglePedal(store.getState().chain[0].uid);
  dispatch({ type: 'recall-snapshot', slot: 0 });
  assert.equal(store.getState().chain[0].enabled, enabledAtCapture);
  assert.equal(store.getState().activeSlot, 0);
  dispatch({ type: 'recall-snapshot', slot: 3 }); // 空槽:不报错
});

test('dispatch toggle-bypass:翻转全局 Bypass 并同步引擎', () => {
  const { store, engineCalls, dispatch } = setup();
  dispatch({ type: 'toggle-bypass' });
  assert.equal(store.getState().globalBypass, true);
  assert.deepEqual(
    engineCalls.find((c) => c.method === 'setGlobalBypass')?.args,
    [true],
  );
  dispatch({ type: 'toggle-bypass' });
  assert.equal(store.getState().globalBypass, false);
});

test('dispatch set-master-volume / set-amp-param:落在 store verb 并同步引擎', () => {
  const { store, engineCalls, dispatch } = setup();
  dispatch({ type: 'set-master-volume', value: 0.8 });
  assert.equal(store.getState().masterVolume, 0.8);
  assert.deepEqual(engineCalls.find((c) => c.method === 'setMasterVolume')?.args, [0.8]);
  dispatch({ type: 'set-amp-param', key: 'gain', value: 77 });
  assert.equal(store.getState().ampValues.gain, 77);
  assert.deepEqual(engineCalls.find((c) => c.method === 'updateAmpParam')?.args, ['gain', 77]);
});

test('dispatch 箱头前均衡动作落在统一 store verbs', () => {
  const { store, engineCalls, dispatch } = setup();
  dispatch({ type: 'toggle-preamp-eq' });
  dispatch({ type: 'set-preamp-eq-band', key: 'hz1000', value: 4 });
  dispatch({ type: 'set-preamp-eq-level', value: -2 });
  assert.equal(store.getState().preAmpEq.enabled, true);
  assert.equal(store.getState().preAmpEq.bands.hz1000, 4);
  assert.equal(store.getState().preAmpEq.levelDb, -2);
  assert.deepEqual(
    engineCalls.filter((call) => call.method.includes('PreAmpEq')).map((call) => call.method),
    ['setPreAmpEqEnabled', 'updatePreAmpEqBand', 'setPreAmpEqLevel'],
  );
});

test('dispatch set-pedal-param / set-pedal-treadle:写第 index 块的参数', () => {
  const { store, engineCalls, dispatch } = setup();
  const uid = store.getState().chain[1].uid;
  dispatch({ type: 'set-pedal-param', index: 1, key: 'drive', value: 55 });
  assert.equal(store.getState().chain[1].values.drive, 55);
  assert.deepEqual(engineCalls.find((c) => c.method === 'updateParam')?.args, [uid, 'drive', 55]);
  dispatch({ type: 'set-pedal-treadle', index: 1, value: 42 });
  assert.equal(store.getState().chain[1].values.position, 42);
});

test('dispatch looper 三种:走注入的 Looper 控制,不碰 rig 状态', () => {
  const { store, looperCalls, dispatch } = setup();
  const before = store.getState().graphVersion;
  dispatch({ type: 'looper-record' });
  dispatch({ type: 'looper-toggle-play' });
  dispatch({ type: 'looper-clear' });
  assert.deepEqual(looperCalls, ['primary', 'togglePlay', 'clear']);
  assert.equal(store.getState().graphVersion, before);
});

test('dispatch set-expression:序数 → 链上第 N 块摇杆踏板(whammy/wahpedal/crybabywdf)', () => {
  const { store, dispatch } = setup();
  store.addPedal('whammy');
  store.addPedal('crybabywdf');
  const treadles = store
    .getState()
    .chain.filter((i) => i.effectId === 'whammy' || i.effectId === 'crybabywdf');
  assert.equal(treadles.length, 2);
  dispatch({ type: 'set-expression', index: 0, value: 0.5 });
  dispatch({ type: 'set-expression', index: 1, value: 1 });
  const after = store.getState().chain;
  assert.equal(after.find((i) => i.uid === treadles[0].uid)?.values.position, 50);
  assert.equal(after.find((i) => i.uid === treadles[1].uid)?.values.position, 100);
  // 序数越界:无动作不报错
  dispatch({ type: 'set-expression', index: 5, value: 1 });
});
