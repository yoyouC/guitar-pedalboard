import assert from 'node:assert/strict';
import test from 'node:test';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';
import type {
  CanonicalPublishedPresetRevision,
  OpaquePublishedPresetRevision,
} from '../shared/marketplace.ts';
import { Tone3000Error } from '../src/tone3000/client.ts';
import { resolvePublishedRevisionCompatibility } from '../src/marketplace/revisionCompatibility.ts';

function externalRevision(): CanonicalPublishedPresetRevision {
  return {
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
}

test('TONE3000 compatibility asks for authorization before inspecting private facts', async () => {
  let inspected = false;
  const result = await resolvePublishedRevisionCompatibility(externalRevision(), {
    isAuthenticated: () => false,
    async inspect() { inspected = true; },
  });
  assert.equal(inspected, false);
  assert.equal(result.status, 'authorization-required');
});

test('authenticated checks distinguish available and unavailable exact models', async () => {
  assert.equal((await resolvePublishedRevisionCompatibility(externalRevision(), {
    isAuthenticated: () => true,
    async inspect() {},
  })).status, 'compatible');

  const unavailable = await resolvePublishedRevisionCompatibility(externalRevision(), {
    isAuthenticated: () => true,
    async inspect() {
      throw new Tone3000Error('tone-unavailable', 'gone', 404);
    },
  });
  assert.equal(unavailable.status, 'incompatible');
  assert.deepEqual(unavailable.blockers[0], {
    kind: 'tone3000', dependencyKey: 'tone3000:42:9001',
    availability: 'unavailable', reason: 'deleted',
  });
});

test('future schemas remain viewable but cannot be applied', async () => {
  const current = externalRevision();
  const future: OpaquePublishedPresetRevision = {
    ...current,
    payloadKind: 'opaque',
    schemaVersion: 999,
    rig: structuredClone(current.rig),
  };
  const result = await resolvePublishedRevisionCompatibility(future, {
    isAuthenticated: () => true,
    async inspect() {},
  });
  assert.equal(result.status, 'incompatible');
  assert.deepEqual(result.blockers[0], {
    kind: 'schema-version', schemaVersion: 999, supportedMin: 2, supportedMax: 5,
  });
});

test('retired catalog gear is an exact compatibility blocker', async () => {
  const revision = externalRevision();
  revision.resourceDependencies = [{ kind: 'builtin' }];
  revision.rig.chain[0].effectId = 'retired-pedal';
  revision.derivedAttributes.pedalIds = ['retired-pedal'];
  const result = await resolvePublishedRevisionCompatibility(revision, {
    isAuthenticated: () => true,
    async inspect() {},
  });
  assert.equal(result.status, 'incompatible');
  assert.deepEqual(result.blockers[0], {
    kind: 'catalog-item', equipmentKind: 'pedal', id: 'retired-pedal',
  });
});
