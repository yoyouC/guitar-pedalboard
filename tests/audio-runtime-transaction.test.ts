import assert from 'node:assert/strict';
import test from 'node:test';
import { profileSwitchBlock, runRuntimeTransaction } from '../src/audio/runtimeTransaction.ts';

test('runtime transaction commits only after preparation and activation', async () => {
  const events: string[] = [];
  await runRuntimeTransaction({
    prepare: async () => {
      events.push('prepare');
      return { id: 'candidate' };
    },
    activate: async () => {
      events.push('activate');
    },
    commit: async () => {
      events.push('commit');
    },
    rollback: async () => {
      events.push('rollback');
    },
  });
  assert.deepEqual(events, ['prepare', 'activate', 'commit']);
});

test('runtime transaction rolls candidate back when activation fails', async () => {
  const events: string[] = [];
  const candidate = { id: 'candidate' };
  await assert.rejects(
    runRuntimeTransaction({
      prepare: async () => {
        events.push('prepare');
        return candidate;
      },
      activate: async () => {
        events.push('activate');
        throw new Error('resume failed');
      },
      commit: async () => {
        events.push('commit');
      },
      rollback: async (value) => {
        assert.equal(value, candidate);
        events.push('rollback');
      },
    }),
    /resume failed/,
  );
  assert.deepEqual(events, ['prepare', 'activate', 'rollback']);
});

test('runtime transaction rolls an empty candidate back when preparation fails', async () => {
  let rolledBack: unknown = 'not-called';
  await assert.rejects(
    runRuntimeTransaction({
      prepare: async () => {
        throw new Error('worklet failed');
      },
      activate: async () => undefined,
      commit: async () => undefined,
      rollback: async (candidate) => {
        rolledBack = candidate;
      },
    }),
    /worklet failed/,
  );
  assert.equal(rolledBack, null);
});

test('profile switch guard blocks recording and non-empty Looper only', () => {
  assert.equal(profileSwitchBlock(true, { phase: 'empty', lengthSeconds: 0 }), 'recording');
  assert.equal(profileSwitchBlock(false, { phase: 'playing', lengthSeconds: 2 }), 'looper-not-empty');
  assert.equal(profileSwitchBlock(false, { phase: 'empty', lengthSeconds: 0 }), null);
});
