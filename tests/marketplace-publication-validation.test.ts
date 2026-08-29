import assert from 'node:assert/strict';
import test from 'node:test';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';
import {
  validatePublicationFields,
  validatePublishPresetRequest,
} from '../shared/marketplacePublication.ts';
import { RIG_PRESET_CATALOG } from '../shared/rigPresetCatalog.ts';
import { normalizeRig } from '../src/state/presetCodec.ts';

const tags = new Set(['tone-crunch', 'genre-rock']);

function validRequest() {
  return {
    title: 'Demo Crunch',
    description: 'Plain <b>text</b> is stored as text, never markup.',
    tagIds: ['tone-crunch'],
    schemaVersion: demoPublishedPreset.currentRevision.schemaVersion,
    rig: demoPublishedPreset.currentRevision.rig,
  };
}

test('publication derives searchable Rig attributes and resource dependencies', () => {
  const result = validatePublishPresetRequest(validRequest(), tags);

  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.value?.resourceDependencies, [{ kind: 'builtin' }]);
  assert.deepEqual(result.value?.derivedAttributes, {
    pedalIds: [],
    ampId: 'crunch',
    ampModelKey: 'builtin:crunch',
    cabId: 'gb4x12',
    resourceKinds: ['builtin'],
  });
});

test('publication losslessly normalizes supported old schemas and rejects lossy payloads', () => {
  const { preAmpEq: _removedInV4, ...v4Rig } = structuredClone(validRequest().rig);
  const { ir: _removedInV3, ...legacyCab } = v4Rig.cab;
  for (const [schemaVersion, rig] of [
    [2, { ...v4Rig, cab: legacyCab }],
    [3, { ...v4Rig, cab: legacyCab }],
    [4, v4Rig],
  ] as const) {
    const migrated = validatePublishPresetRequest({
      ...validRequest(), schemaVersion, rig,
    }, tags);

    assert.deepEqual(migrated.errors, {});
    assert.equal(migrated.value?.request.schemaVersion, 5);
    assert.equal(migrated.value?.request.rig.preAmpEq.enabled, false);
    assert.deepEqual(Object.values(migrated.value!.request.rig.preAmpEq.bands), Array(10).fill(0));
    assert.deepEqual(migrated.value?.request.rig.cab.ir, { kind: 'builtin', id: rig.cab.id });
  }

  const lossy = validatePublishPresetRequest({
    ...validRequest(), schemaVersion: 4, rig: { ...v4Rig, unknownSoundField: 42 },
  }, tags);
  assert.equal(lossy.value, null);
  assert.equal(lossy.errors.rig, '旧版 Rig 无法无损迁移，请升级客户端后发布');

  const future = validatePublishPresetRequest({ ...validRequest(), schemaVersion: 999 }, tags);
  assert.equal(future.value, null);
  assert.equal(future.errors.rig, 'Rig 版本不受支持（支持 2–5），请升级客户端');
});

test('publication rejects forged ownership and local-only Rig resources', () => {
  const forged = validatePublishPresetRequest({
    ...validRequest(),
    ownerId: 'member-attacker-choice',
  }, tags);
  assert.equal(forged.value, null);
  assert.equal(forged.errors.rig, '发布数据包含不允许的字段');

  const localCab = validatePublishPresetRequest({
    ...validRequest(),
    rig: {
      ...validRequest().rig,
      cab: {
        id: 'customIr',
        ir: { kind: 'custom', hash: 'a'.repeat(64) },
        enabled: true,
        values: { level: 0 },
      },
    },
  }, tags);
  assert.equal(localCab.value, null);
  assert.equal(localCab.errors.rig, 'Rig 无法无损发布或包含本机资源');
});

test('client and server share exact metadata and tag validation messages', () => {
  assert.deepEqual(validatePublicationFields({
    title: '',
    description: 'x'.repeat(2_001),
    tagIds: [],
  }), {
    title: '标题不能为空',
    description: '介绍最多 2,000 个字符',
    tagIds: '请选择 1–5 个标签',
  });

  const unavailable = validatePublishPresetRequest({
    ...validRequest(),
    tagIds: ['deprecated-tag'],
  }, tags);
  assert.equal(unavailable.errors.tagIds, '包含不可用标签');

  assert.deepEqual(validatePublicationFields({
    title: '🎸'.repeat(80),
    description: '🎶'.repeat(2_000),
    tagIds: ['tone-crunch'],
  }), {});
  assert.equal(validatePublicationFields({
    title: '🎸'.repeat(81),
    description: '',
    tagIds: ['tone-crunch'],
  }).title, '标题最多 80 个字符');
});

test('Tone3000 Amp and Pedal keep exact external references in derived dependencies', () => {
  const rig = normalizeRig({
    ...validRequest().rig,
    chain: [{
      effectId: 'tone3000Nam',
      modelRef: 'tone3000:42',
      modelId: '9001',
      enabled: true,
      values: {},
      post: false,
    }],
    amp: {
      categoryId: 'tone3000',
      modelKey: 'tone3000:79103',
      modelId: '1234',
      enabled: true,
      values: {},
      customName: null,
    },
  }, RIG_PRESET_CATALOG);
  const result = validatePublishPresetRequest({ ...validRequest(), rig }, tags);

  assert.deepEqual(result.value?.resourceDependencies, [
    { kind: 'builtin' },
    { kind: 'tone3000', toneId: '79103', modelId: '1234' },
    { kind: 'tone3000', toneId: '42', modelId: '9001' },
  ]);
  assert.deepEqual(result.value?.derivedAttributes, {
    pedalIds: ['tone3000Nam'],
    ampId: 'nam-wasm',
    ampModelKey: 'tone3000:79103',
    cabId: 'gb4x12',
    resourceKinds: ['builtin', 'tone3000'],
  });
});
