import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INITIAL_LOOPER_STATUS,
  looperPrimaryCommand,
  type LooperPhase,
  type LooperStatus,
} from '../src/audio/looperState.ts';

/** 记录每次主按钮分派调用了哪个引擎方法 */
function makeEngine(phase: LooperPhase) {
  const calls: string[] = [];
  const engine = {
    calls,
    startLoopRecording: () => calls.push('start-rec'),
    finishLoopRecording: () => calls.push('finish-rec'),
    startLoopOverdub: () => calls.push('start-dub'),
    finishLoopOverdub: () => calls.push('finish-dub'),
    currentLooperStatus: {
      ...INITIAL_LOOPER_STATUS,
      available: true,
      phase,
    } as LooperStatus,
  };
  return engine;
}

test('looperPrimaryCommand 按相位分派完整状态机', () => {
  const flow: [LooperPhase, string][] = [
    ['empty', 'start-rec'],
    ['recording', 'finish-rec'],
    ['playing', 'start-dub'],
    ['stopped', 'start-dub'],
    ['overdubbing', 'finish-dub'],
  ];
  for (const [phase, expected] of flow) {
    const engine = makeEngine(phase);
    looperPrimaryCommand(engine);
    assert.deepEqual(engine.calls, [expected], `phase=${phase}`);
  }
});
