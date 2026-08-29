import assert from 'node:assert/strict';
import test from 'node:test';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';
import { evaluatePublishedPresetRevisionCompatibility } from '../shared/marketplaceCompatibility.ts';
import type { CanonicalPublishedPresetRevision } from '../shared/marketplace.ts';

test('compatibility is recomputed from the immutable revision and current catalog', () => {
  const retiredRevision: CanonicalPublishedPresetRevision = {
    ...structuredClone(demoPublishedPreset.currentRevision),
    derivedAttributes: {
      ...demoPublishedPreset.currentRevision.derivedAttributes,
      pedalIds: ['retired-pedal'],
      ampModelKey: 'builtin:retired-amp',
      cabId: 'retired-cab',
    },
    rig: {
      ...structuredClone(demoPublishedPreset.currentRevision.rig),
      chain: [{
        effectId: 'retired-pedal', enabled: true, values: { drive: 42 }, post: false,
      }],
      amp: {
        categoryId: 'retired', modelKey: 'builtin:retired-amp', enabled: true,
        values: { gain: 42 }, customName: null,
      },
      cab: {
        id: 'retired-cab', ir: { kind: 'builtin', id: 'retired-cab' as 'gb4x12' },
        enabled: true, values: { level: -2 },
      },
    },
  };
  const originalPayload = structuredClone(retiredRevision.rig);

  assert.deepEqual(evaluatePublishedPresetRevisionCompatibility(retiredRevision), {
    status: 'incompatible',
    blockers: [
      { kind: 'catalog-item', equipmentKind: 'pedal', id: 'retired-pedal' },
      { kind: 'catalog-item', equipmentKind: 'amp', id: 'builtin:retired-amp' },
      { kind: 'catalog-item', equipmentKind: 'cab', id: 'retired-cab' },
    ],
  });
  assert.deepEqual(retiredRevision.rig, originalPayload);
});

test('future schemas retain metadata but produce an explicit upgrade blocker', () => {
  const compatibility = evaluatePublishedPresetRevisionCompatibility({
    ...demoPublishedPreset.currentRevision,
    payloadKind: 'opaque',
    schemaVersion: 999,
    rig: { futurePayload: true },
  });

  assert.deepEqual(compatibility, {
    status: 'incompatible',
    blockers: [{
      kind: 'schema-version', schemaVersion: 999, supportedMin: 2, supportedMax: 5,
    }],
  });
});

test('TONE3000 availability facts distinguish authorization from resource loss', () => {
  const revision: CanonicalPublishedPresetRevision = {
    ...structuredClone(demoPublishedPreset.currentRevision),
    resourceDependencies: [
      { kind: 'builtin' },
      { kind: 'tone3000', toneId: '42', modelId: '9001' },
    ],
    derivedAttributes: {
      ...demoPublishedPreset.currentRevision.derivedAttributes,
      pedalIds: ['tone3000Nam'],
      resourceKinds: ['builtin', 'tone3000'],
    },
    rig: {
      ...structuredClone(demoPublishedPreset.currentRevision.rig),
      chain: [{
        effectId: 'tone3000Nam', modelRef: 'tone3000:42', modelId: '9001',
        enabled: true, values: { level: 0 }, post: false,
      }],
    },
  };

  assert.equal(evaluatePublishedPresetRevisionCompatibility(revision, [{
    dependencyKey: 'tone3000:42:9001', availability: 'available',
  }]).status, 'compatible');
  assert.equal(evaluatePublishedPresetRevisionCompatibility(revision, [{
    dependencyKey: 'tone3000:42:9001', availability: 'authorization-required',
  }]).status, 'authorization-required');
  assert.deepEqual(evaluatePublishedPresetRevisionCompatibility(revision, [{
    dependencyKey: 'tone3000:42:9001', availability: 'unavailable', reason: 'private',
  }]), {
    status: 'incompatible',
    blockers: [{
      kind: 'tone3000', dependencyKey: 'tone3000:42:9001',
      availability: 'unavailable', reason: 'private',
    }],
  });
});
