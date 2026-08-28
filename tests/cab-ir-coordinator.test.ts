import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CabIrCoordinator,
  type CabIrLibraryPort,
  type CabIrRuntimePort,
  type StoredCabIr,
} from '../src/audio/cabIrCoordinator.ts';
import type { CabIrRef } from '../src/audio/cabIrTypes.ts';

const builtin: CabIrRef = { kind: 'builtin', id: 'gb4x12' };
const custom: CabIrRef = { kind: 'custom', hash: 'abc123' };

function harness(overrides: {
  prepare?: CabIrRuntimePort['prepare'];
  put?: CabIrLibraryPort['put'];
  get?: CabIrLibraryPort['get'];
  activate?: CabIrRuntimePort['activate'];
} = {}) {
  const events: string[] = [];
  let committed: CabIrRef = builtin;
  const stored: StoredCabIr = {
    hash: 'abc123',
    name: 'room.wav',
    blob: new Blob(['wav']),
    bytes: 3,
    channels: 1,
    originalSampleRate: 48_000,
    processedSampleRate: 48_000,
    durationSeconds: 0.1,
    trimmedFrames: 0,
    createdAt: 1,
    lastUsedAt: 1,
  };
  const library: CabIrLibraryPort = {
    get: overrides.get ?? (async () => stored),
    put: overrides.put ?? (async () => {
      events.push('persist');
      return { rollback: async () => { events.push('rollback'); } };
    }),
    touch: async () => {},
  };
  const runtime: CabIrRuntimePort = {
    prepare: overrides.prepare ?? (async () => { events.push('prepare'); return { token: 1 }; }),
    activate: overrides.activate ?? (() => { events.push('activate'); }),
  };
  const coordinator = new CabIrCoordinator({
    library,
    runtime,
    commit: (ref) => { events.push('commit'); committed = ref; },
  });
  return { coordinator, events, committed: () => committed, stored };
}

test('selection prepares candidate before audible activation and canonical commit', async () => {
  const h = harness();
  const result = await h.coordinator.select(custom);
  assert.equal(result.ok, true);
  assert.deepEqual(h.events, ['prepare', 'activate', 'commit']);
  assert.deepEqual(h.committed(), custom);
});

test('runtime preparation failure leaves canonical selection and library untouched', async () => {
  const h = harness({ prepare: async () => { throw new Error('decode failed'); } });
  const result = await h.coordinator.select(custom);
  assert.equal(result.ok, false);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.committed(), builtin);
});

test('import persists only after validation/runtime preparation and commits last', async () => {
  const h = harness();
  const result = await h.coordinator.importPrepared(h.stored, { decoded: true });
  assert.equal(result.ok, true);
  assert.deepEqual(h.events, ['prepare', 'persist', 'activate', 'commit']);
  assert.deepEqual(h.committed(), custom);
});

test('failed persistence does not activate or commit imported IR', async () => {
  const h = harness({ put: async () => { throw new Error('quota'); } });
  const result = await h.coordinator.importPrepared(h.stored, { decoded: true });
  assert.equal(result.ok, false);
  assert.deepEqual(h.events, ['prepare']);
  assert.deepEqual(h.committed(), builtin);
});

test('activation failure rolls back the imported record and any LRU changes', async () => {
  const activationEvents: string[] = [];
  const h = harness({
    activate: () => {
      activationEvents.push('activate');
      throw new Error('runtime changed');
    },
  });
  const result = await h.coordinator.importPrepared(h.stored, { decoded: true });
  assert.equal(result.ok, false);
  assert.deepEqual(activationEvents, ['activate']);
  assert.deepEqual(h.events, ['prepare', 'persist', 'rollback']);
  assert.deepEqual(h.committed(), builtin);
});

test('late import preparation cannot persist or overwrite a newer selection', async () => {
  let resolveImport!: (value: unknown) => void;
  const delayed = new Promise<unknown>((resolve) => { resolveImport = resolve; });
  const events: string[] = [];
  let committed: CabIrRef = custom;
  const stored = harness().stored;
  const coordinator = new CabIrCoordinator({
    library: {
      get: async () => null,
      put: async () => { events.push('persist-import'); },
      touch: async () => {},
    },
    runtime: {
      prepare: async (_ref, source) => source ? delayed : { builtin: true },
      activate: () => { events.push('activate'); },
    },
    commit: (ref) => { committed = ref; events.push(`commit:${ref.kind}`); },
  });

  const first = coordinator.importPrepared(stored, { decoded: true });
  await Promise.resolve();
  const second = coordinator.select(builtin);
  resolveImport({ imported: true });
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.ok, false);
  assert.equal(!firstResult.ok && firstResult.reason, 'superseded');
  assert.equal(secondResult.ok, true);
  assert.deepEqual(committed, builtin);
  assert.equal(events.includes('persist-import'), false);
});

test('rig restore commits the whole rig only after the requested IR is prepared', async () => {
  const h = harness();
  const result = await h.coordinator.restore(custom, () => h.events.push('commit-rig'));
  assert.deepEqual(result, { ok: true, ref: custom, fallback: false });
  assert.deepEqual(h.events, ['prepare', 'activate', 'commit-rig']);
});

test('rig restore preserves a missing custom ref while activating Greenback fallback', async () => {
  const preparedRefs: CabIrRef[] = [];
  const activatedCanonicalRefs: CabIrRef[] = [];
  const coordinator = new CabIrCoordinator({
    library: {
      get: async () => null,
      put: async () => {},
      touch: async () => {},
    },
    runtime: {
      prepare: async (ref) => {
        preparedRefs.push(ref);
        return { ref };
      },
      activate: (_prepared, canonicalRef) => {
        if (canonicalRef) activatedCanonicalRefs.push(canonicalRef);
      },
    },
    commit: () => assert.fail('restore must use its whole-rig commit callback'),
  });

  const events: string[] = [];
  const result = await coordinator.restore(custom, () => events.push('commit-rig'));
  assert.deepEqual(result, { ok: true, ref: custom, fallback: true });
  assert.deepEqual(preparedRefs, [builtin]);
  assert.deepEqual(activatedCanonicalRefs, [custom]);
  assert.deepEqual(events, ['commit-rig']);
});

test('rig restore decode failure leaves the whole rig uncommitted', async () => {
  const h = harness({ prepare: async () => { throw new Error('decode failed'); } });
  let committed = false;
  const result = await h.coordinator.restore(custom, () => { committed = true; });
  assert.equal(result.ok, false);
  assert.equal(committed, false);
});
