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

function memorySessionStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, String(value)),
    removeItem: (key: string) => void data.delete(key),
  };
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
  assert.deepEqual(store.getState().provenance, {
    presetId: demoPublishedPreset.id,
    revisionId: demoPublishedPreset.currentRevision.id,
    creatorId: demoPublishedPreset.creator.id,
    presetUpdatedAt: demoPublishedPreset.updatedAt,
  });
  assert.deepEqual(store.getState().presets, beforePresets);
  assert.deepEqual(store.getState().snapshots, beforeSnapshots);

  const undone = await session.undo();
  assert.deepEqual(undone, { ok: true });
  assert.deepEqual(rigToApplyState(store.getState()), beforeRig);
  assert.equal(store.getState().provenance, null);
  assert.equal(session.canUndo(), false);
});

test('published provenance survives editing and local Preset round-trips until an explicit fresh start', async () => {
  const store = createRigStore(createStubEngine());
  const session = createPublishedPresetRigSession(store);

  assert.deepEqual(await session.apply(demoPublishedPreset), { ok: true });
  store.setAmpParam('gain', 72);
  store.savePreset('Remix Draft');
  store.savePreset('Remix Draft Copy');

  assert.deepEqual(
    store.getState().presets.map((preset) => preset.provenance),
    [store.getState().provenance, store.getState().provenance],
  );

  assert.deepEqual(await store.startFromFactoryRig(), { ok: true });
  assert.equal(store.getState().provenance, null);
  assert.deepEqual(await store.loadPreset('Remix Draft Copy'), { ok: true });
  assert.equal(store.getState().ampValues.gain, 72);
  assert.deepEqual(store.getState().provenance, {
    presetId: demoPublishedPreset.id,
    revisionId: demoPublishedPreset.currentRevision.id,
    creatorId: demoPublishedPreset.creator.id,
    presetUpdatedAt: demoPublishedPreset.updatedAt,
  });

  assert.deepEqual(await store.startFromBlankRig(), { ok: true });
  assert.equal(store.getState().chain.length, 0);
  assert.equal(store.getState().provenance, null);
});

test('consecutive Tone comparisons preserve the first My Original Rig and expose Modified state', async () => {
  const store = createRigStore(createStubEngine());
  store.setAmpParam('gain', 17);
  const original = rigToApplyState(store.getState());
  const session = createPublishedPresetRigSession(store, memorySessionStorage());
  const secondTone = structuredClone(demoPublishedPreset);
  secondTone.id = 'preset-second-tone';
  secondTone.title = 'Second Tone';
  secondTone.currentRevision.id = 'revision-second-tone-1';
  secondTone.currentRevision.rig.amp.values.gain = 83;

  assert.deepEqual(await session.apply(demoPublishedPreset), { ok: true });
  assert.equal(session.getState().modified, false);
  store.setAmpParam('gain', 72);
  assert.equal(session.getState().modified, true);
  assert.deepEqual(await session.apply(secondTone), { ok: true });
  assert.equal(session.getState().tone?.id, secondTone.id);
  assert.equal(session.getState().modified, false);
  assert.equal(store.getState().ampValues.gain, 83);

  assert.deepEqual(await session.backToOriginal(), { ok: true });
  assert.deepEqual(rigToApplyState(store.getState()), original);
  assert.deepEqual(session.getState(), {
    tone: null,
    modified: false,
    canReturnToOriginal: false,
  });
  session.dispose();
});

test('Tone comparison restore point survives route remounts in browser-session storage', async () => {
  const store = createRigStore(createStubEngine());
  store.setAmpParam('gain', 19);
  const original = rigToApplyState(store.getState());
  const storage = memorySessionStorage();
  const firstRouteSession = createPublishedPresetRigSession(store, storage);
  assert.deepEqual(await firstRouteSession.apply(demoPublishedPreset), { ok: true });
  firstRouteSession.dispose();

  const remountedSession = createPublishedPresetRigSession(store, storage);
  assert.equal(remountedSession.getState().tone?.id, demoPublishedPreset.id);
  assert.deepEqual(await remountedSession.backToOriginal(), { ok: true });
  assert.deepEqual(rigToApplyState(store.getState()), original);
  remountedSession.dispose();
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
