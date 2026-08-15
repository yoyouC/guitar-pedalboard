import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRigPreset,
  exportRigPresetsJson,
  importRigPresetsJson,
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
  ],
  amps: [
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
    { key: 'nam-wasm:fender-twinverb', categoryId: 'clean', ampId: 'nam-wasm' },
  ],
  ampCategoryIds: ['clean', 'crunch'],
  defaults: {
    ampModelKey: 'nam-wasm:fender-twinverb',
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
      modelKey: 'nam-wasm:fender-twinverb',
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

  assert.equal(imported[0].version, 2);
  assert.equal(imported[0].rig.chain[0].post, true);
  assert.equal(imported[0].rig.chain[0].values.time, 2);
  assert.equal(imported[0].rig.amp.modelKey, 'nam-wasm:fender-twinverb');
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
      modelKey: 'nam-wasm:fender-twinverb',
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
