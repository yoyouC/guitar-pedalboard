import assert from 'node:assert/strict';
import test from 'node:test';
import { demoPublishedPreset } from '../server/marketplace/demoPreset.ts';
import {
  publishRigFromLocalSource,
  repairProvenanceFromPublishedPreset,
} from '../src/marketplace/publishRig.ts';
import type { PublishPresetRequest } from '../shared/marketplace.ts';
import type { RigProvenance } from '../src/state/presetCodec.ts';

const request: PublishPresetRequest = {
  title: 'Edited Crunch',
  description: '',
  tagIds: ['tone-crunch'],
  schemaVersion: 5,
  rig: demoPublishedPreset.currentRevision.rig,
};

const provenance: RigProvenance = {
  presetId: demoPublishedPreset.id,
  revisionId: demoPublishedPreset.currentRevision.id,
  creatorId: demoPublishedPreset.creator.id,
  presetUpdatedAt: demoPublishedPreset.updatedAt,
};

test('a Rig without provenance publishes a new independent work', async () => {
  const calls: unknown[] = [];
  const result = await publishRigFromLocalSource({
    client: {
      async publishPreset(next) { calls.push(['create', next]); return demoPublishedPreset; },
      async appendPublishedPresetRevision() { throw new Error('unexpected append'); },
    },
    currentMemberId: 'member-ada',
    request,
    provenance: null,
  });

  assert.equal(result.preset, demoPublishedPreset);
  assert.equal(result.kind, 'new-work');
  assert.deepEqual(calls, [['create', request]]);
});

test('another creator provenance publishes a new Remix with the fixed source pair', async () => {
  const calls: unknown[] = [];
  const result = await publishRigFromLocalSource({
    client: {
      async publishPreset(next) { calls.push(['create', next]); return demoPublishedPreset; },
      async appendPublishedPresetRevision() { throw new Error('unexpected append'); },
    },
    currentMemberId: 'member-ada',
    request,
    provenance: repairProvenanceFromPublishedPreset(demoPublishedPreset),
  });

  assert.equal(result.kind, 'remix');
  assert.deepEqual(calls, [['create', {
    ...request,
    source: {
      presetId: provenance.presetId,
      revisionId: provenance.revisionId,
    },
  }]]);
});

test('own provenance appends a revision to the source work by default', async () => {
  const calls: unknown[] = [];
  const result = await publishRigFromLocalSource({
    client: {
      async publishPreset() { throw new Error('unexpected create'); },
      async appendPublishedPresetRevision(id, next) {
        calls.push(['append', id, next]);
        return demoPublishedPreset;
      },
    },
    currentMemberId: provenance.creatorId,
    request,
    provenance,
  });

  assert.equal(result.kind, 'new-revision');
  assert.deepEqual(calls, [['append', provenance.presetId, {
    schemaVersion: request.schemaVersion,
    rig: request.rig,
    expectedUpdatedAt: provenance.presetUpdatedAt,
  }]]);
});

test('manual repair routes by ownership without mutating the historical source payload', async () => {
  const historicalRig = structuredClone(demoPublishedPreset.currentRevision.rig);
  const repairSource = repairProvenanceFromPublishedPreset(demoPublishedPreset);
  const repairedRequest = {
    ...request,
    rig: {
      ...structuredClone(request.rig),
      amp: { ...structuredClone(request.rig.amp), values: { ...request.rig.amp.values, gain: 73 } },
    },
  };
  const calls: unknown[] = [];
  await publishRigFromLocalSource({
    client: {
      async publishPreset(next) { calls.push(next); return demoPublishedPreset; },
      async appendPublishedPresetRevision() { throw new Error('unexpected append'); },
    },
    currentMemberId: 'member-repairer',
    request: repairedRequest,
    provenance: repairSource,
  });

  assert.deepEqual(demoPublishedPreset.currentRevision.rig, historicalRig);
  assert.deepEqual((calls[0] as PublishPresetRequest).source, {
    presetId: repairSource.presetId,
    revisionId: repairSource.revisionId,
  });
});
