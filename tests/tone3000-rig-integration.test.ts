import assert from 'node:assert/strict';
import test from 'node:test';
import { createRigStore, type RigEngine } from '../src/state/rigStore.ts';
import {
  createTone3000RigIntegration,
  type Tone3000RigPort,
} from '../src/tone3000/rigIntegration.ts';

function installLocalStorage() {
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
    },
  });
}

function stubEngine(): RigEngine {
  const noop = () => {};
  return {
    setGlobalBypass: noop,
    setChain: noop,
    setAmp: noop,
    setCab: noop,
    updateParam: noop,
    updateAmpParam: noop,
    updateCabParam: noop,
    setInputGain: noop,
    setMasterVolume: noop,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test.beforeEach(installLocalStorage);

test('addPedal validates gear, inserts loading ChainItem, then becomes ready', async () => {
  const model = deferred<string>();
  const port: Tone3000RigPort = {
    getTone: async (toneId) => ({
      id: Number(toneId),
      title: 'Cloud Drive',
      username: 'alice',
      license: 'cc-by',
      url: `https://www.tone3000.com/tones/${toneId}`,
      gear: 'pedal',
      format: 'nam',
    }),
    loadModelText: async () => model.promise,
  };
  const rig = createRigStore(stubEngine());
  const integration = createTone3000RigIntegration({ rig, port });

  const adding = integration.addPedal('42', '9001');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const item = rig.getState().chain.find((candidate) => candidate.modelRef === 'tone3000:42')!;
  assert.ok(item, 'gear 校验后立即插入 canonical Chain');
  assert.equal(integration.getState().targets[`pedal:${item.uid}`]?.phase, 'loading');

  model.resolve('{"metadata":{"name":"Cloud Drive"}}');
  const result = await adding;
  assert.deepEqual(result, { ok: true, uid: item.uid });
  assert.equal(integration.getState().targets[`pedal:${item.uid}`]?.phase, 'ready');
});

test('addPedal rejects non-pedal or non-NAM metadata without mutating the Rig', async () => {
  let gear = 'amp';
  let format: string | undefined = 'nam';
  const port: Tone3000RigPort = {
    getTone: async (toneId) => ({
      id: Number(toneId),
      title: 'Wrong capture',
      username: 'alice',
      license: 't3k',
      url: `https://www.tone3000.com/tones/${toneId}`,
      gear,
      ...(format ? { format } : {}),
    }),
    loadModelText: async () => {
      throw new Error('validation must happen before download');
    },
  };
  const rig = createRigStore(stubEngine());
  const before = rig.getState().chain.length;
  const integration = createTone3000RigIntegration({ rig, port });

  assert.equal((await integration.addPedal('60')).ok, false);
  gear = 'pedal';
  format = 'ir';
  assert.equal((await integration.addPedal('61')).ok, false);
  format = undefined;
  assert.equal((await integration.addPedal('62')).ok, false);
  assert.equal(rig.getState().chain.length, before);
});

test('public intents reject malformed tone/model identities before calling the adapter', async () => {
  let metadataCalls = 0;
  const port: Tone3000RigPort = {
    getTone: async () => {
      metadataCalls += 1;
      throw new Error('must not be reached');
    },
    loadModelText: async () => '{}',
  };
  const rig = createRigStore(stubEngine());
  const integration = createTone3000RigIntegration({ rig, port });
  assert.equal((await integration.addPedal('../42')).ok, false);
  assert.equal((await integration.addPedal('42', 'not-numeric')).ok, false);
  assert.equal((await integration.selectAmp('42', '')).ok, false);
  assert.equal(metadataCalls, 0);
});

test('validated add remains a repairable placeholder when download fails', async () => {
  const port: Tone3000RigPort = {
    getTone: async (toneId) => ({
      id: Number(toneId), title: 'Offline Drive', username: 'alice', license: 't3k',
      url: `https://www.tone3000.com/tones/${toneId}`, gear: 'pedal', format: 'nam',
    }),
    loadModelText: async () => {
      throw Object.assign(new Error('network down'), { reason: 'http' });
    },
  };
  const rig = createRigStore(stubEngine());
  const integration = createTone3000RigIntegration({ rig, port });
  const result = await integration.addPedal('63');
  assert.equal(result.ok, true, 'gear 校验后的用户意图已提交，下载失败是运行态');
  assert.equal(rig.getState().chain.some((item) => item.modelRef === 'tone3000:63'), true);
  if (result.ok) {
    assert.equal(integration.getState().targets[`pedal:${result.uid}`]?.reason, 'http');
  }
});

test('replacePedal is transactional: failed candidate keeps old model and successful candidate preserves uid', async () => {
  let failDownload = true;
  const port: Tone3000RigPort = {
    getTone: async (toneId) => ({
      id: Number(toneId),
      title: `Pedal ${toneId}`,
      username: 'alice',
      license: 't3k',
      url: `https://www.tone3000.com/tones/${toneId}`,
      gear: 'pedal',
      format: 'nam',
    }),
    loadModelText: async () => {
      if (failDownload) throw Object.assign(new Error('offline'), { reason: 'http' });
      return '{}';
    },
  };
  const rig = createRigStore(stubEngine());
  const uid = rig.addTone3000Pedal('tone3000:10', '100');
  rig.setPedalParam(uid, 'level', -4);
  const integration = createTone3000RigIntegration({ rig, port });

  const failed = await integration.replacePedal(uid, '11', '101');
  assert.equal(failed.ok, false);
  let item = rig.getState().chain.find((candidate) => candidate.uid === uid)!;
  assert.equal(item.modelRef, 'tone3000:10');
  assert.equal(item.modelId, '100');
  assert.equal(item.values.level, -4);
  assert.equal(integration.getState().targets[`pedal:${uid}`]?.toneId, '10');

  failDownload = false;
  const succeeded = await integration.replacePedal(uid, '11', '101');
  assert.deepEqual(succeeded, { ok: true, uid });
  item = rig.getState().chain.find((candidate) => candidate.uid === uid)!;
  assert.equal(item.modelRef, 'tone3000:11');
  assert.equal(item.modelId, '101');
  assert.equal(item.values.level, -4);
});

test('concurrent replace: 较早的异步结果不能覆盖后发选择', async () => {
  const downloads = new Map<string, ReturnType<typeof deferred<string>>>();
  const port: Tone3000RigPort = {
    getTone: async (toneId) => ({
      id: Number(toneId), title: `Pedal ${toneId}`, username: 'alice', license: 't3k',
      url: `https://www.tone3000.com/tones/${toneId}`, gear: 'pedal', format: 'nam',
    }),
    loadModelText: async (modelRef) => {
      const request = deferred<string>();
      downloads.set(modelRef, request);
      return request.promise;
    },
  };
  const rig = createRigStore(stubEngine());
  const uid = rig.addTone3000Pedal('tone3000:10');
  const integration = createTone3000RigIntegration({ rig, port });
  const older = integration.replacePedal(uid, '11');
  const newer = integration.replacePedal(uid, '12');
  await new Promise((resolve) => setTimeout(resolve, 0));
  downloads.get('tone3000:12')!.resolve('{}');
  assert.equal((await newer).ok, true);
  downloads.get('tone3000:11')!.resolve('{}');
  assert.equal((await older).ok, false);
  assert.equal(rig.getState().chain.find((item) => item.uid === uid)?.modelRef, 'tone3000:12');
  assert.equal(integration.getState().targets[`pedal:${uid}`]?.toneId, '12');
});

test('add download finishing after an immediate replace cannot restore the added tone state', async () => {
  const downloads = new Map<string, ReturnType<typeof deferred<string>>>();
  const port: Tone3000RigPort = {
    getTone: async (toneId) => ({
      id: Number(toneId), title: `Pedal ${toneId}`, username: 'alice', license: 't3k',
      url: `https://www.tone3000.com/tones/${toneId}`, gear: 'pedal', format: 'nam',
    }),
    loadModelText: async (modelRef) => {
      const request = deferred<string>();
      downloads.set(modelRef, request);
      return request.promise;
    },
  };
  const rig = createRigStore(stubEngine());
  const integration = createTone3000RigIntegration({ rig, port });
  const adding = integration.addPedal('41');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const uid = rig.getState().chain.find((item) => item.modelRef === 'tone3000:41')!.uid;
  const replacing = integration.replacePedal(uid, '42');
  await new Promise((resolve) => setTimeout(resolve, 0));

  downloads.get('tone3000:42')!.resolve('{}');
  assert.equal((await replacing).ok, true);
  downloads.get('tone3000:41')!.resolve('{}');
  assert.equal((await adding).ok, true);
  assert.equal(rig.getState().chain.find((item) => item.uid === uid)?.modelRef, 'tone3000:42');
  assert.equal(integration.getState().targets[`pedal:${uid}`]?.toneId, '42');
});

test('restoreAll isolates failures and retryAll recovers every current Tone3000 target', async () => {
  let authenticated = false;
  const port: Tone3000RigPort = {
    getTone: async (toneId) => ({
      id: Number(toneId),
      title: `Tone ${toneId}`,
      username: 'alice',
      license: 't3k',
      url: `https://www.tone3000.com/tones/${toneId}`,
      gear: toneId === '99' ? 'amp' : 'pedal',
      format: 'nam',
    }),
    loadModelText: async () => {
      if (!authenticated) {
        throw Object.assign(new Error('login required'), { reason: 'not-authenticated' });
      }
      return '{}';
    },
  };
  const rig = createRigStore(stubEngine());
  const first = rig.addTone3000Pedal('tone3000:21');
  const second = rig.addTone3000Pedal('tone3000:22', '220');
  rig.setAmpModel('tone3000', 'tone3000:99', '990');
  rig.setAmpParam('gain', 33);
  const integration = createTone3000RigIntegration({ rig, port });

  await integration.restoreAll();
  assert.equal(integration.getState().targets[`pedal:${first}`]?.reason, 'not-authenticated');
  assert.equal(integration.getState().targets[`pedal:${second}`]?.reason, 'not-authenticated');
  assert.equal(integration.getState().targets.amp?.reason, 'not-authenticated');

  authenticated = true;
  await integration.retryAll();
  assert.equal(integration.getState().targets[`pedal:${first}`]?.phase, 'ready');
  assert.equal(integration.getState().targets[`pedal:${second}`]?.phase, 'ready');
  assert.equal(integration.getState().targets.amp?.phase, 'ready');
  assert.equal(rig.getState().ampId, 'nam-wasm');
  assert.equal(rig.getState().ampValues.gain, 33);
});

test('restoreAll projects exact sample metadata for the current Amp summary', async () => {
  const port: Tone3000RigPort = {
    getTone: async (toneId) => ({
      id: Number(toneId), title: 'Restored Amp', username: 'alice', license: 't3k',
      url: `https://www.tone3000.com/tones/${toneId}`, gear: 'amp', format: 'nam',
    }),
    getModelInfo: async (toneId, modelId) => ({
      id: modelId,
      toneId,
      name: 'Restored Drive',
      size: 'feather',
      architecture: '2',
    }),
    loadModelText: async () => '{}',
  };
  const rig = createRigStore(stubEngine());
  rig.setAmpModel('tone3000', 'tone3000:64', '6402');
  const integration = createTone3000RigIntegration({ rig, port });

  await integration.restoreAll();

  assert.deepEqual(integration.getState().targets.amp?.sample, {
    id: '6402',
    toneId: '64',
    name: 'Restored Drive',
    size: 'feather',
    architecture: '2',
  });
});

test('restoreAll limits concurrent model downloads to two', async () => {
  let active = 0;
  let peak = 0;
  const releases: Array<() => void> = [];
  const port: Tone3000RigPort = {
    getTone: async (toneId) => ({
      id: Number(toneId),
      title: `Tone ${toneId}`,
      username: 'alice',
      license: 't3k',
      url: `https://www.tone3000.com/tones/${toneId}`,
      gear: 'pedal',
      format: 'nam',
    }),
    loadModelText: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return '{}';
    },
  };
  const rig = createRigStore(stubEngine());
  rig.addTone3000Pedal('tone3000:1');
  rig.addTone3000Pedal('tone3000:2');
  rig.addTone3000Pedal('tone3000:3');
  const integration = createTone3000RigIntegration({ rig, port });

  const restoring = integration.restoreAll();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(releases.length, 2);
  releases.shift()!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(releases.length, 2, '一个完成后才启动第三个');
  while (releases.length) releases.shift()!();
  await restoring;
  assert.equal(peak, 2);
});

test('download queue is shared by concurrent high-level intents', async () => {
  let active = 0;
  let peak = 0;
  const releases: Array<() => void> = [];
  const port: Tone3000RigPort = {
    getTone: async (toneId) => ({
      id: Number(toneId), title: `Pedal ${toneId}`, username: 'alice', license: 't3k',
      url: `https://www.tone3000.com/tones/${toneId}`, gear: 'pedal', format: 'nam',
    }),
    loadModelText: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return '{}';
    },
  };
  const integration = createTone3000RigIntegration({ rig: createRigStore(stubEngine()), port });
  const pending = Promise.all([
    integration.addPedal('71'),
    integration.addPedal('72'),
    integration.addPedal('73'),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(releases.length, 2);
  releases.shift()!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(releases.length, 2);
  while (releases.length) releases.shift()!();
  await pending;
  assert.equal(peak, 2);
});

test('selectAmp accepts only Amp gear and retains exact modelId', async () => {
  let gear = 'pedal';
  const port: Tone3000RigPort = {
    getTone: async (toneId) => ({
      id: Number(toneId),
      title: 'Selected',
      username: 'alice',
      license: 't3k',
      url: `https://www.tone3000.com/tones/${toneId}`,
      gear,
      format: 'nam',
    }),
    loadModelText: async () => '{}',
  };
  const rig = createRigStore(stubEngine());
  const integration = createTone3000RigIntegration({ rig, port });
  assert.equal((await integration.selectAmp('31', '301')).ok, false);
  assert.equal(rig.getState().ampCategoryId, 'crunch');

  gear = 'amp';
  assert.deepEqual(await integration.selectAmp('31', '301'), { ok: true, uid: 'amp' });
  assert.equal(rig.getState().ampModelKeys.tone3000, 'tone3000:31');
  assert.equal(rig.getState().ampTone3000ModelId, '301');
});

test('prepareSelection keeps a multi-sample tone pending with hosted model preselected', async () => {
  const port: Tone3000RigPort = {
    getTone: async (toneId) => ({
      id: Number(toneId), title: 'Multi capture', username: 'alice', license: 't3k',
      url: `https://www.tone3000.com/tones/${toneId}`, gear: 'amp', format: 'nam',
    }),
    listModels: async () => [
      { id: '4203', toneId: '42', name: 'Crunch 10', size: 'lite', architecture: '2' },
      { id: '4201', toneId: '42', name: 'Clean', size: 'standard', architecture: '1' },
      { id: '4202', toneId: '42', name: 'Crunch 2', size: 'standard', architecture: '2' },
    ],
    loadModelText: async () => {
      throw new Error('选择确认前不得下载模型');
    },
  };
  const rig = createRigStore(stubEngine());
  const integration = createTone3000RigIntegration({ rig, port });

  const result = await integration.prepareSelection(
    '42',
    '4202',
    { kind: 'amp', architecture: '2' },
  );

  assert.deepEqual(result, { ok: true, status: 'choose' });
  assert.deepEqual(integration.getState().selection, {
    toneId: '42',
    preferredModelId: '4202',
    samples: [
      { id: '4202', toneId: '42', name: 'Crunch 2', size: 'standard', architecture: '2' },
      { id: '4203', toneId: '42', name: 'Crunch 10', size: 'lite', architecture: '2' },
      { id: '4201', toneId: '42', name: 'Clean', size: 'standard', architecture: '1' },
    ],
    intent: { kind: 'amp', architecture: '2' },
    currentModelUnavailable: false,
  });
  assert.equal(rig.getState().ampCategoryId, 'crunch');
});

test('prepareSelection ignores a sample list that finishes after a newer tone choice', async () => {
  const lists = new Map<string, ReturnType<typeof deferred<Awaited<ReturnType<NonNullable<Tone3000RigPort['listModels']>>>>>>();
  const port: Tone3000RigPort = {
    getTone: async (toneId) => ({
      id: Number(toneId), title: `Tone ${toneId}`, username: 'alice', license: 't3k',
      url: `https://www.tone3000.com/tones/${toneId}`, gear: 'amp', format: 'nam',
    }),
    listModels: async (toneId) => {
      const list = deferred<Awaited<ReturnType<NonNullable<Tone3000RigPort['listModels']>>>>();
      lists.set(toneId, list);
      return list.promise;
    },
    loadModelText: async () => '{}',
  };
  const integration = createTone3000RigIntegration({ rig: createRigStore(stubEngine()), port });
  const older = integration.prepareSelection('51', undefined, { kind: 'amp', architecture: '2' });
  const newer = integration.prepareSelection('52', undefined, { kind: 'amp', architecture: '2' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  lists.get('52')!.resolve([
    { id: '5201', toneId: '52', name: 'A', size: 'standard', architecture: '2' },
    { id: '5202', toneId: '52', name: 'B', size: 'lite', architecture: '2' },
  ]);
  assert.deepEqual(await newer, { ok: true, status: 'choose' });
  lists.get('51')!.resolve([
    { id: '5101', toneId: '51', name: 'A', size: 'standard', architecture: '2' },
    { id: '5102', toneId: '51', name: 'B', size: 'lite', architecture: '2' },
  ]);
  assert.equal((await older).ok, false);
  assert.equal(integration.getState().selection?.toneId, '52');
});

test('prepareSelection applies the only sample with its exact modelId', async () => {
  const port: Tone3000RigPort = {
    getTone: async (toneId) => ({
      id: Number(toneId), title: 'Only capture', username: 'alice', license: 't3k',
      url: `https://www.tone3000.com/tones/${toneId}`, gear: 'pedal', format: 'nam',
    }),
    listModels: async () => [
      { id: '4301', toneId: '43', name: 'Only', size: 'standard', architecture: '2' },
    ],
    loadModelText: async (_modelRef, modelId) => {
      assert.equal(modelId, '4301');
      return '{}';
    },
  };
  const rig = createRigStore(stubEngine());
  const integration = createTone3000RigIntegration({ rig, port });

  const result = await integration.prepareSelection(
    '43',
    undefined,
    { kind: 'add-pedal', architecture: '2' },
  );

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.status, 'applied');
  const item = rig.getState().chain.find((candidate) => candidate.modelRef === 'tone3000:43');
  assert.equal(item?.modelId, '4301');
  assert.equal(integration.getState().selection, undefined);
});

test('confirmSelection applies an offered sample and clears the pending choice', async () => {
  const port: Tone3000RigPort = {
    getTone: async (toneId) => ({
      id: Number(toneId), title: 'Amp pack', username: 'alice', license: 't3k',
      url: `https://www.tone3000.com/tones/${toneId}`, gear: 'amp', format: 'nam',
    }),
    listModels: async () => [
      { id: '4401', toneId: '44', name: 'Clean', size: 'standard', architecture: '1' },
      { id: '4402', toneId: '44', name: 'Drive', size: 'standard', architecture: '2' },
    ],
    loadModelText: async (_modelRef, modelId) => {
      assert.equal(modelId, '4401');
      return '{}';
    },
  };
  const rig = createRigStore(stubEngine());
  const integration = createTone3000RigIntegration({ rig, port });
  await integration.prepareSelection('44', '4402', { kind: 'amp', architecture: '2' });

  const result = await integration.confirmSelection('4401');

  assert.deepEqual(result, { ok: true, uid: 'amp' });
  assert.equal(rig.getState().ampModelKeys.tone3000, 'tone3000:44');
  assert.equal(rig.getState().ampTone3000ModelId, '4401');
  assert.equal(integration.getState().selection, undefined);
});

test('Amp sample switch keeps the current tone and Amp parameters until exact download succeeds', async () => {
  const model = deferred<string>();
  const port: Tone3000RigPort = {
    getTone: async (toneId) => ({
      id: Number(toneId), title: 'Amp pack', username: 'alice', license: 't3k',
      url: `https://www.tone3000.com/tones/${toneId}`, gear: 'amp', format: 'nam',
    }),
    listModels: async () => [
      { id: '4502', toneId: '45', name: 'Drive', size: 'standard', architecture: '2' },
      { id: '4501', toneId: '45', name: 'Clean', size: 'standard', architecture: '2' },
    ],
    loadModelText: async (_modelRef, modelId) => {
      assert.equal(modelId, '4502');
      return model.promise;
    },
  };
  const rig = createRigStore(stubEngine());
  rig.setAmpModel('tone3000', 'tone3000:45', '4501');
  rig.setAmpParam('gain', 77);
  const integration = createTone3000RigIntegration({ rig, port });

  assert.deepEqual(await integration.prepareAmpSampleSwitch(), { ok: true, status: 'choose' });
  assert.equal(integration.getState().selection?.samples[0].id, '4501', '当前采样置顶');
  const switching = integration.confirmSelection('4502');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(rig.getState().ampTone3000ModelId, '4501');
  assert.equal(rig.getState().ampValues.gain, 77);

  model.resolve('{}');
  assert.deepEqual(await switching, { ok: true, uid: 'amp' });
  assert.equal(rig.getState().ampModelKeys.tone3000, 'tone3000:45');
  assert.equal(rig.getState().ampTone3000ModelId, '4502');
  assert.equal(rig.getState().ampValues.gain, 77);
});

test('Pedal sample switch preserves uid, placement, enabled state, and LEVEL', async () => {
  const port: Tone3000RigPort = {
    getTone: async (toneId) => ({
      id: Number(toneId), title: 'Drive pack', username: 'alice', license: 't3k',
      url: `https://www.tone3000.com/tones/${toneId}`, gear: 'pedal', format: 'nam',
    }),
    listModels: async () => [
      { id: '4601', toneId: '46', name: 'Low', size: 'standard', architecture: '2' },
      { id: '4602', toneId: '46', name: 'High', size: 'lite', architecture: '2' },
    ],
    loadModelText: async (_modelRef, modelId) => {
      assert.equal(modelId, '4602');
      return '{}';
    },
  };
  const rig = createRigStore(stubEngine());
  const uid = rig.addTone3000Pedal('tone3000:46', '4601');
  rig.setPedalParam(uid, 'level', -7);
  rig.setPedalPost(uid);
  rig.setPedalEnabled(uid, false);
  const integration = createTone3000RigIntegration({ rig, port });

  assert.deepEqual(await integration.preparePedalSampleSwitch(uid), { ok: true, status: 'choose' });
  assert.deepEqual(await integration.confirmSelection('4602'), { ok: true, uid });

  const item = rig.getState().chain.find((candidate) => candidate.uid === uid)!;
  assert.equal(item.modelRef, 'tone3000:46');
  assert.equal(item.modelId, '4602');
  assert.equal(item.values.level, -7);
  assert.equal(item.post, true);
  assert.equal(item.enabled, false);
});

test('selectHosted owns OAuth intent and resolves the returned tone through sample choice', async () => {
  let request: Parameters<NonNullable<Tone3000RigPort['selectTone']>>[0] | undefined;
  const port: Tone3000RigPort = {
    getTone: async (toneId) => ({
      id: Number(toneId), title: 'Hosted pedal', username: 'alice', license: 't3k',
      url: `https://www.tone3000.com/tones/${toneId}`, gear: 'pedal', format: 'nam',
    }),
    listModels: async () => [
      { id: '880', toneId: '88', name: 'Hosted', size: 'standard', architecture: '2' },
      { id: '881', toneId: '88', name: 'Hosted Lite', size: 'lite', architecture: '2' },
    ],
    loadModelText: async () => '{}',
    selectTone: async (next) => {
      request = next;
      return { toneId: '88', modelId: '880' };
    },
  };
  const rig = createRigStore(stubEngine());
  const integration = createTone3000RigIntegration({ rig, port });
  const result = await integration.selectHosted({ kind: 'add-pedal' }, '2');
  assert.deepEqual(result, { ok: true, status: 'choose' });
  assert.deepEqual(request, {
    intent: { kind: 'add-pedal', architecture: '2' },
    gear: 'pedal',
    architecture: '2',
  });
  assert.equal(integration.getState().selection?.preferredModelId, '880');
  assert.equal(rig.getState().chain.some((item) => item.modelRef === 'tone3000:88'), false);
});

test('applySelection owns redirect replace remapping after Share regenerated the uid', async () => {
  const port: Tone3000RigPort = {
    getTone: async (toneId) => ({
      id: Number(toneId), title: 'Replacement', username: 'alice', license: 't3k',
      url: `https://www.tone3000.com/tones/${toneId}`, gear: 'pedal', format: 'nam',
    }),
    loadModelText: async () => '{}',
  };
  const rig = createRigStore(stubEngine());
  const uid = rig.addTone3000Pedal('tone3000:10');
  const returnIndex = rig.getState().chain.findIndex((item) => item.uid === uid);
  const integration = createTone3000RigIntegration({ rig, port });
  const result = await integration.applySelection('11', undefined, {
    kind: 'replace-pedal',
    uid: 'pre-redirect-uid',
    architecture: 'legacy',
    returnIndex,
    returnModelRef: 'tone3000:10',
  });
  assert.equal(result.ok, true);
  assert.equal(rig.getState().chain.find((item) => item.uid === uid)?.modelRef, 'tone3000:11');
});

test('login is a high-level intent that retries every failed target', async () => {
  let authenticated = false;
  let loginCalls = 0;
  const port: Tone3000RigPort = {
    getTone: async (toneId) => ({
      id: Number(toneId), title: `Tone ${toneId}`, username: 'alice', license: 't3k',
      url: `https://www.tone3000.com/tones/${toneId}`,
      gear: toneId === '99' ? 'amp' : 'pedal', format: 'nam',
    }),
    loadModelText: async () => {
      if (!authenticated) {
        throw Object.assign(new Error('login required'), { reason: 'not-authenticated' });
      }
      return '{}';
    },
    login: async () => {
      loginCalls += 1;
      authenticated = true;
      return true;
    },
  };
  const rig = createRigStore(stubEngine());
  const uid = rig.addTone3000Pedal('tone3000:21');
  rig.setAmpModel('tone3000', 'tone3000:99');
  const integration = createTone3000RigIntegration({ rig, port });
  await integration.restoreAll();
  assert.equal(integration.getState().targets[`pedal:${uid}`]?.phase, 'error');
  assert.equal(integration.getState().targets.amp?.phase, 'error');

  assert.equal(await integration.login(), true);
  assert.equal(loginCalls, 1);
  assert.equal(integration.getState().targets[`pedal:${uid}`]?.phase, 'ready');
  assert.equal(integration.getState().targets.amp?.phase, 'ready');
});

test('logout clears credentials/cache without discarding current Rig target', async () => {
  let loggedOut = 0;
  let cacheCleared = 0;
  const port: Tone3000RigPort = {
    getTone: async (toneId) => ({
      id: Number(toneId),
      title: 'Cloud Drive',
      username: 'alice',
      license: 't3k',
      url: `https://www.tone3000.com/tones/${toneId}`,
      gear: 'pedal',
      format: 'nam',
    }),
    loadModelText: async () => '{}',
    logout: () => void (loggedOut += 1),
    clearModelCache: () => void (cacheCleared += 1),
  };
  const rig = createRigStore(stubEngine());
  const integration = createTone3000RigIntegration({ rig, port });
  const result = await integration.addPedal('50');
  assert.equal(result.ok, true);
  integration.logout();
  assert.equal(loggedOut, 1);
  assert.equal(cacheCleared, 1);
  assert.equal(rig.getState().chain.some((item) => item.modelRef === 'tone3000:50'), true);
});
