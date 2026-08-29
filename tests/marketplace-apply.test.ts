import assert from 'node:assert/strict';
import test from 'node:test';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';
import { createPublishedPresetRigSession } from '../src/marketplace/applyPublishedPreset.ts';
import { createRigStore, rigToApplyState, type RigEngine } from '../src/state/rigStore.ts';

function installLocalStorage() {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, String(value)),
      removeItem: (key: string) => void data.delete(key),
      clear: () => data.clear(),
    },
  });
}

function createStubEngine(): RigEngine {
  const ignore = () => undefined;
  return {
    applyRig: ignore,
    setGlobalBypass: ignore,
    setChain: ignore,
    setAmp: ignore,
    setCab: ignore,
    setPreAmpEq: ignore,
    setPreAmpEqEnabled: ignore,
    updatePreAmpEqBand: ignore,
    setPreAmpEqLevel: ignore,
    updateParam: ignore,
    updateAmpParam: ignore,
    updateCabParam: ignore,
    setInputGain: ignore,
    setMasterVolume: ignore,
  };
}

test.beforeEach(installLocalStorage);

test('applying a published preset creates a session undo point without saving local data', async () => {
  const store = createRigStore(createStubEngine());
  store.setAmpParam('gain', 17);
  store.setMasterVolume(0.73);
  store.savePreset('My Local Tone');
  store.captureSnapshot(0);
  const beforeRig = rigToApplyState(store.getState());
  const beforePresets = structuredClone(store.getState().presets);
  const beforeSnapshots = structuredClone(store.getState().snapshots);
  const session = createPublishedPresetRigSession(store);

  const applied = await session.apply(demoPublishedPreset);

  assert.deepEqual(applied, { ok: true });
  assert.equal(session.canUndo(), true);
  assert.equal(store.getState().ampValues.gain, 60);
  assert.deepEqual(store.getState().presets, beforePresets);
  assert.deepEqual(store.getState().snapshots, beforeSnapshots);

  const undone = await session.undo();
  assert.deepEqual(undone, { ok: true });
  assert.deepEqual(rigToApplyState(store.getState()), beforeRig);
  assert.equal(session.canUndo(), false);
});

test('a future Rig schema is rejected without changing the local Rig', async () => {
  const store = createRigStore(createStubEngine());
  const before = rigToApplyState(store.getState());
  const session = createPublishedPresetRigSession(store);

  const result = await session.apply({
    ...demoPublishedPreset,
    currentRevision: {
      ...demoPublishedPreset.currentRevision,
      payloadKind: 'opaque',
      schemaVersion: 999,
    },
  });

  assert.deepEqual(result, {
    ok: false,
    message: '当前客户端无法忠实应用这个音色，请升级后再试。',
  });
  assert.deepEqual(rigToApplyState(store.getState()), before);
  assert.equal(session.canUndo(), false);
});

test('a current-schema revision with a retired catalog item stays visible but cannot apply lossily', async () => {
  const store = createRigStore(createStubEngine());
  const before = rigToApplyState(store.getState());
  const session = createPublishedPresetRigSession(store);

  const result = await session.apply({
    title: 'Retired Pedal',
    currentRevision: {
      ...demoPublishedPreset.currentRevision,
      derivedAttributes: {
        ...demoPublishedPreset.currentRevision.derivedAttributes,
        pedalIds: ['retired-pedal'],
      },
      rig: {
        ...demoPublishedPreset.currentRevision.rig,
        chain: [{
          effectId: 'retired-pedal',
          enabled: true,
          values: { drive: 42 },
          post: false,
        }],
      },
    },
  });

  assert.deepEqual(result, {
    ok: false,
    message: '当前客户端无法忠实应用这个音色，请升级后再试。',
  });
  assert.deepEqual(rigToApplyState(store.getState()), before);
  assert.equal(session.canUndo(), false);
});

test('an unexpected restore failure stays inside the marketplace session boundary', async () => {
  const store = createRigStore(createStubEngine());
  const before = rigToApplyState(store.getState());
  store.setRigRestoreHandler(async () => {
    throw new Error('runtime disappeared');
  });
  const session = createPublishedPresetRigSession(store);

  const result = await session.apply(demoPublishedPreset);

  assert.deepEqual(result, {
    ok: false,
    message: '应用过程异常；请检查当前 Rig 后重试。',
  });
  assert.deepEqual(rigToApplyState(store.getState()), before);
  assert.equal(session.canUndo(), false);
});
