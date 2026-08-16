import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRigPreset,
  exportRigPresetsJson,
  importRigPresetsJson,
  normalizeRigPreset,
  normalizeSnapshot,
  restoreRigPreset,
  type RigPresetCatalog,
} from '../src/state/presetCodec.ts';

const catalog: RigPresetCatalog = {
  effects: [
    {
      id: 'drive',
      defaultPost: false,
      params: [
        { key: 'gain', min: 0, max: 10, defaultValue: 5 },
      ],
    },
    {
      id: 'delay',
      defaultPost: true,
      params: [
        { key: 'time', min: 0.05, max: 2, defaultValue: 0.4 },
      ],
    },
    {
      id: 'tone3000Nam',
      defaultPost: false,
      params: [{ key: 'level', min: -30, max: 6, defaultValue: 0 }],
    },
  ],
  amps: [
    {
      id: 'clean',
      params: [{ key: 'gain', min: 0, max: 100, defaultValue: 40 }],
    },
    {
      id: 'nam-wasm',
      params: [{ key: 'gain', min: 0, max: 100, defaultValue: 50 }],
    },
  ],
  cabs: [
    {
      id: 'open1x12',
      params: [{ key: 'level', min: -24, max: 6, defaultValue: 0 }],
    },
  ],
  ampModels: [
    { key: 'builtin:clean', categoryId: 'clean', ampId: 'clean' },
  ],
  ampCategoryIds: ['clean', 'crunch'],
  defaults: {
    ampModelKey: 'builtin:clean',
    cabId: 'open1x12',
    inputGain: 1,
    masterVolume: 0.5,
  },
};

test('full rig preset round-trips and clamps every parameter domain', () => {
  const preset = createRigPreset('  Stage A  ', {
    chain: [{
      effectId: 'drive',
      enabled: true,
      values: { gain: 99 },
      post: false,
    }],
    amp: {
      categoryId: 'clean',
      modelKey: 'builtin:clean',
      enabled: false,
      values: { gain: -20 },
      customName: null,
    },
    cab: {
      id: 'open1x12',
      enabled: false,
      values: { level: 100 },
    },
    globals: {
      inputGain: 5,
      masterVolume: -1,
      bypass: true,
    },
  }, catalog);

  assert.equal(preset.name, 'Stage A');
  assert.equal(preset.rig.chain[0].values.gain, 10);
  assert.equal(preset.rig.amp.values.gain, 0);
  assert.equal(preset.rig.cab.values.level, 6);
  assert.deepEqual(preset.rig.globals, {
    inputGain: 2,
    masterVolume: 0,
    bypass: true,
  });

  const restored = restoreRigPreset(preset, catalog, () => 'stable-uid');
  assert.equal(restored.chain[0].uid, 'stable-uid');
  assert.equal(restored.amp.enabled, false);
  assert.equal(restored.cab.enabled, false);
});

test('legacy chain-only presets migrate with safe rig defaults', () => {
  const imported = importRigPresetsJson(JSON.stringify([{
    name: 'Old Delay',
    items: [{
      effectId: 'delay',
      enabled: true,
      values: { time: 99 },
    }],
  }]), catalog);

  assert.equal(imported[0].version, 3);
  assert.equal(imported[0].rig.chain[0].post, true);
  assert.equal(imported[0].rig.chain[0].values.time, 2);
  assert.equal(imported[0].rig.amp.modelKey, 'builtin:clean');
  assert.equal(imported[0].rig.cab.id, 'open1x12');
  assert.deepEqual(imported[0].rig.globals, {
    inputGain: 1,
    masterVolume: 0.5,
    bypass: false,
  });
});

test('preset export envelope imports again and drops unknown modules', () => {
  const preset = createRigPreset('Portable', {
    chain: [],
    amp: {
      categoryId: 'clean',
      modelKey: 'builtin:clean',
      enabled: true,
      values: {},
      customName: null,
    },
    cab: { id: 'open1x12', enabled: true, values: {} },
    globals: { inputGain: 1, masterVolume: 0.5, bypass: false },
  }, catalog);
  const exported = exportRigPresetsJson([preset]);
  const payload = JSON.parse(exported) as {
    format: string;
    presets: unknown[];
  };
  assert.equal(payload.format, 'guitar-pedalboard-presets');
  assert.equal(payload.presets.length, 1);
  assert.equal(importRigPresetsJson(exported, catalog)[0].name, 'Portable');

  const withUnknownEffect = JSON.parse(exported) as {
    presets: Array<{ rig: { chain: unknown[] } }>;
  };
  withUnknownEffect.presets[0].rig.chain = [{
    effectId: 'missing',
    enabled: true,
    values: {},
    post: false,
  }];
  assert.deepEqual(
    importRigPresetsJson(JSON.stringify(withUnknownEffect), catalog)[0].rig.chain,
    [],
  );
});

test('preset import reports malformed and unsupported files', () => {
  assert.throws(
    () => importRigPresetsJson('{oops', catalog),
    /不是有效的 JSON/,
  );
  assert.throws(
    () => importRigPresetsJson('{"hello":"world"}', catalog),
    /不支持的预设文件格式/,
  );
});

test('tone3000 model key survives normalize (kind-prefix rule, not static table)', () => {
  const preset = createRigPreset('T3K', {
    chain: [],
    amp: {
      categoryId: 'tone3000',
      modelKey: 'tone3000:79103',
      enabled: true,
      values: { gain: 999 },
      customName: null,
    },
    cab: { id: 'open1x12', enabled: true, values: { level: 0 } },
    globals: { inputGain: 1, masterVolume: 0.5, bypass: false },
  }, catalog);
  assert.equal(preset.rig.amp.modelKey, 'tone3000:79103');
  assert.equal(preset.rig.amp.categoryId, 'tone3000');
  // 参数按 nam-wasm def 钳制(测试目录里 nam-wasm gain max=100)
  assert.equal(preset.rig.amp.values.gain, 100);
});

test('v3 preset keeps Tone3000 Pedal tone and exact model variant through restore', () => {
  const preset = createRigPreset('Cloud Pedal', {
    chain: [{
      effectId: 'tone3000Nam',
      modelRef: 'tone3000:42',
      modelId: '9001',
      enabled: true,
      values: { level: 99 },
      post: false,
    }],
    amp: {
      categoryId: 'clean',
      modelKey: 'builtin:clean',
      enabled: true,
      values: {},
      customName: null,
    },
    cab: { id: 'open1x12', enabled: true, values: {} },
    globals: { inputGain: 1, masterVolume: 0.5, bypass: false },
  }, catalog);

  assert.equal(preset.version, 3);
  assert.deepEqual(preset.rig.chain[0], {
    effectId: 'tone3000Nam',
    modelRef: 'tone3000:42',
    modelId: '9001',
    enabled: true,
    values: { level: 6 },
    post: false,
  });
  assert.deepEqual(
    restoreRigPreset(preset, catalog, () => 'cloud-uid').chain[0],
    { ...preset.rig.chain[0], uid: 'cloud-uid' },
  );
});

test('v2 canonical preset migrates to v3 without changing its Rig', () => {
  const migrated = normalizeRigPreset({
    version: 2,
    name: 'Version Two',
    rig: {
      chain: [{ effectId: 'drive', enabled: false, values: { gain: 7 }, post: false }],
      amp: { categoryId: 'clean', modelKey: 'builtin:clean', enabled: true, values: { gain: 30 } },
      cab: { id: 'open1x12', enabled: true, values: { level: -3 } },
      globals: { inputGain: 1.2, masterVolume: 0.7, bypass: false },
    },
  }, catalog)!;

  assert.equal(migrated.version, 3);
  assert.equal(migrated.rig.chain[0].effectId, 'drive');
  assert.equal(migrated.rig.amp.modelKey, 'builtin:clean');
  assert.equal(migrated.rig.cab.values.level, -3);
});

test('malformed external ids are rejected before graph projection', () => {
  const normalized = normalizeRigPreset({
    version: 3,
    name: 'Untrusted',
    rig: {
      chain: [
        { effectId: 'tone3000Nam', modelRef: 'tone3000:not-a-number', enabled: true, values: {}, post: false },
        { effectId: 'tone3000Nam', modelRef: 'other:42', enabled: true, values: {}, post: false },
      ],
      amp: { categoryId: 'tone3000', modelKey: 'tone3000:../42', enabled: true, values: {} },
      cab: { id: 'open1x12', enabled: true, values: {} },
      globals: {},
    },
  }, catalog)!;

  assert.deepEqual(normalized.rig.chain, []);
  assert.equal(normalized.rig.amp.modelKey, 'builtin:clean');
});

test('unversioned Snapshot retains exact Tone3000 Amp variant', () => {
  const snapshot = normalizeSnapshot({
    chain: [],
    amp: {
      categoryId: 'tone3000',
      modelKey: 'tone3000:77',
      modelId: '7001',
      enabled: true,
      values: {},
    },
    cab: { id: 'open1x12', enabled: true, values: {} },
  }, catalog)!;
  assert.equal('modelId' in snapshot.amp ? snapshot.amp.modelId : undefined, '7001');
});
