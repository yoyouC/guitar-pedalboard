import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INITIAL_LOOPER_STATUS,
  canRunLooperCommand,
  formatLooperTime,
  type LooperStatus,
} from '../src/audio/looperState.ts';

function status(
  phase: LooperStatus['phase'],
  overrides: Partial<LooperStatus> = {},
): LooperStatus {
  return {
    ...INITIAL_LOOPER_STATUS,
    available: true,
    phase,
    ...overrides,
  };
}

test('looper command guard follows the record/play/overdub lifecycle', () => {
  assert.equal(canRunLooperCommand(status('empty'), 'record'), true);
  assert.equal(canRunLooperCommand(status('empty'), 'overdub'), false);
  assert.equal(canRunLooperCommand(status('recording'), 'finish-record'), true);
  assert.equal(canRunLooperCommand(status('recording'), 'toggle-play'), false);
  assert.equal(canRunLooperCommand(status('playing'), 'overdub'), true);
  assert.equal(canRunLooperCommand(status('playing'), 'toggle-play'), true);
  assert.equal(canRunLooperCommand(status('overdubbing'), 'finish-overdub'), true);
  assert.equal(canRunLooperCommand(status('overdubbing'), 'undo'), false);
  assert.equal(
    canRunLooperCommand(status('stopped', { canUndo: true }), 'undo'),
    true,
  );
});

test('unavailable looper rejects every state-changing command', () => {
  assert.equal(canRunLooperCommand(INITIAL_LOOPER_STATUS, 'record'), false);
  assert.equal(canRunLooperCommand(INITIAL_LOOPER_STATUS, 'clear'), false);
});

test('looper time formatting is stable for UI and invalid values', () => {
  assert.equal(formatLooperTime(0), '00:00');
  assert.equal(formatLooperTime(65.9), '01:05');
  assert.equal(formatLooperTime(-3), '00:00');
  assert.equal(formatLooperTime(Number.NaN), '00:00');
});
