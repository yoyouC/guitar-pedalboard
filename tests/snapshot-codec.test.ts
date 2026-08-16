import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSnapshot } from '../src/state/presetCodec.ts';
import { loadSnapshots, RIG_PRESET_CATALOG, SNAPSHOT_COUNT } from '../src/state/store.ts';

/**
 * 快照的 normalize 与宽容加载(ADR-0006):
 * 新形状(ampCategoryId+ampModelKey,走型号机制)与 legacy 形状(ampId-only)
 * 都是 Snapshot 类型的合法分支;坏槽位宽容置 null 而不是裸奔 throw。
 */

const SNAPSHOT_KEY = 'guitar-pedalboard-snapshots';

function installLocalStorage(initial?: Record<string, string>) {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
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
  return map;
}

/** 新形状快照(型号机制分支) */
function newShapeSnapshot() {
  return {
    chain: [
      { effectId: 'dynacomp', enabled: true, values: { sensitivity: 55, level: 0 }, post: false },
    ],
    amp: {
      categoryId: 'crunch',
      modelKey: 'nam-wasm-pack:jcm800-sweep',
      enabled: true,
      values: { gain: 64, bass: 50, mid: 50, treble: 15, presence: 50, master: 0 },
    },
    cab: { id: 'gb4x12', enabled: true, values: { level: -13.5 } },
  };
}

/** 旧形状快照(扁平 ampId-only,2026-08 之前的持久化数据) */
function legacyShapeSnapshot() {
  return {
    chain: [
      { effectId: 'overdrive', enabled: false, values: { drive: 30, tone: 50, level: 0 }, post: false },
    ],
    ampId: 'crunch',
    ampEnabled: true,
    ampValues: { gain: 70 },
    cabId: 'gb4x12',
    cabEnabled: false,
    cabValues: { level: -4 },
  };
}

test('normalizeSnapshot: 新形状解析为型号机制分支,参数经 catalog 钳制', () => {
  const raw = newShapeSnapshot();
  raw.amp.values.gain = 9999;
  raw.chain[0].values.sensitivity = -5;
  const snap = normalizeSnapshot(raw, RIG_PRESET_CATALOG)!;
  assert.ok(snap);
  assert.deepEqual(
    { categoryId: (snap.amp as { categoryId?: string }).categoryId, modelKey: (snap.amp as { modelKey?: string }).modelKey },
    { categoryId: 'crunch', modelKey: 'nam-wasm-pack:jcm800-sweep' },
  );
  assert.equal(snap.amp.values.gain, 100);
  assert.equal(snap.chain[0].values.sensitivity, 0);
  assert.equal(snap.cab.id, 'gb4x12');
});

test('normalizeSnapshot: 旧形状解析为 legacy 分支,语义字段完整保留', () => {
  const snap = normalizeSnapshot(legacyShapeSnapshot(), RIG_PRESET_CATALOG)!;
  assert.ok(snap);
  const ref = snap.amp as { legacyAmpId?: string };
  assert.equal(ref.legacyAmpId, 'crunch');
  assert.equal('categoryId' in snap.amp, false);
  assert.equal(snap.amp.enabled, true);
  assert.equal(snap.amp.values.gain, 70);
  assert.equal(snap.cab.enabled, false);
  assert.equal(snap.chain[0].effectId, 'overdrive');
  assert.equal(snap.chain[0].enabled, false);
});

test('normalizeSnapshot: 未知型号回退目录默认箱头,槽位仍存活', () => {
  const raw = newShapeSnapshot();
  raw.amp.modelKey = 'no:such-model';
  raw.amp.categoryId = 'zzz';
  const snap = normalizeSnapshot(raw, RIG_PRESET_CATALOG)!;
  assert.ok(snap);
  assert.equal((snap.amp as { modelKey?: string }).modelKey, 'builtin:crunch');
});

test('normalizeSnapshot: 垃圾输入返回 null(非对象/缺链/未知 legacy ampId)', () => {
  assert.equal(normalizeSnapshot('nope', RIG_PRESET_CATALOG), null);
  assert.equal(normalizeSnapshot({ amp: { modelKey: 'builtin:crunch' } }, RIG_PRESET_CATALOG), null);
  const badAmp = legacyShapeSnapshot();
  badAmp.ampId = 'no-such-amp';
  assert.equal(normalizeSnapshot(badAmp, RIG_PRESET_CATALOG), null);
  const noRef = newShapeSnapshot();
  delete (noRef as Record<string, unknown>).amp;
  assert.equal(normalizeSnapshot(noRef, RIG_PRESET_CATALOG), null);
});

test('loadSnapshots: 坏槽位宽容置 null,好槽位不受影响', () => {
  installLocalStorage({
    [SNAPSHOT_KEY]: JSON.stringify([
      newShapeSnapshot(),
      { garbage: true },
      null,
      legacyShapeSnapshot(),
    ]),
  });
  const slots = loadSnapshots();
  assert.equal(slots.length, SNAPSHOT_COUNT);
  assert.ok(slots[0]);
  assert.equal((slots[0]!.amp as { modelKey?: string }).modelKey, 'nam-wasm-pack:jcm800-sweep');
  assert.equal(slots[1], null);
  assert.equal(slots[2], null);
  assert.equal((slots[3]!.amp as { legacyAmpId?: string }).legacyAmpId, 'crunch');
});

test('loadSnapshots: 顶层非数组 / 坏 JSON → 全空槽', () => {
  installLocalStorage({ [SNAPSHOT_KEY]: JSON.stringify({ not: 'an array' }) });
  assert.deepEqual(loadSnapshots(), Array(SNAPSHOT_COUNT).fill(null));
  installLocalStorage({ [SNAPSHOT_KEY]: '{broken json' });
  assert.deepEqual(loadSnapshots(), Array(SNAPSHOT_COUNT).fill(null));
});

test('loadSnapshots: 槽位数量截断/补齐到 SNAPSHOT_COUNT', () => {
  installLocalStorage({ [SNAPSHOT_KEY]: JSON.stringify([newShapeSnapshot()]) });
  const short = loadSnapshots();
  assert.equal(short.length, SNAPSHOT_COUNT);
  assert.equal(short[1], null);
  installLocalStorage({
    [SNAPSHOT_KEY]: JSON.stringify(Array(9).fill(newShapeSnapshot())),
  });
  assert.equal(loadSnapshots().length, SNAPSHOT_COUNT);
});
