import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeLoopback,
  calibrationMatches,
  createLoopbackSequence,
  loadLoopbackCalibration,
  saveLoopbackCalibration,
  type LoopbackCalibrationKey,
} from '../src/audio/loopbackCalibration.ts';

test('相关检测恢复已知回环 sample 延迟', () => {
  const reference = createLoopbackSequence();
  const delay = 731;
  const captured = new Float32Array(4_000);
  for (let i = 0; i < reference.length; i++) captured[delay + i] = reference[i] * 0.08;
  const result = analyzeLoopback(captured, reference, 48_000);
  assert.equal(result.ok, true);
  assert.ok(Math.abs((result.delaySamples ?? 0) - delay) < 0.05);
  assert.ok((result.delayMs ?? 0) > 15.2 && (result.delayMs ?? 0) < 15.3);
  assert.ok(result.confidence > 0.8);
});

test('相关检测可对分数 sample 延迟做亚采样估计', () => {
  const reference = createLoopbackSequence();
  const delay = 530.35;
  const captured = new Float32Array(3_000);
  const whole = Math.floor(delay);
  const fraction = delay - whole;
  for (let i = 0; i < reference.length; i++) {
    captured[whole + i] += reference[i] * (1 - fraction) * 0.08;
    captured[whole + i + 1] += reference[i] * fraction * 0.08;
  }
  const result = analyzeLoopback(captured, reference, 48_000);
  assert.equal(result.ok, true);
  assert.ok(Math.abs((result.delaySamples ?? 0) - delay) < 0.2, `delay=${result.delaySamples}`);
});

test('双峰回路不会生成可信结果', () => {
  const reference = createLoopbackSequence();
  const captured = new Float32Array(4_000);
  for (const delay of [400, 1_200]) {
    for (let i = 0; i < reference.length; i++) captured[delay + i] += reference[i] * 0.06;
  }
  assert.equal(analyzeLoopback(captured, reference, 48_000).reason, 'ambiguous');
});

test('有效校准可本地持久化，坏数据安全忽略', () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
  };
  const calibration = {
    key: { inputDeviceId: 'in', outputDeviceId: 'out', sampleRate: 48_000, profile: 'realtime' as const, browserMajor: 'Chrome 1', osAudioConfig: 'macOS-default' },
    delayMs: 7.5,
    confidence: 0.9,
    measuredAt: '2026-08-26T00:00:00.000Z',
  };
  saveLoopbackCalibration(calibration, storage);
  assert.deepEqual(loadLoopbackCalibration(storage), calibration);
  data.set('guitar-pedalboard-loopback-calibration-v1', '{bad');
  assert.equal(loadLoopbackCalibration(storage), null);
});

test('静音与削波不会生成往返时延', () => {
  const reference = createLoopbackSequence();
  assert.equal(analyzeLoopback(new Float32Array(2_000), reference, 48_000).reason, 'too-quiet');
  const clipped = new Float32Array(2_000);
  clipped.fill(1);
  assert.equal(analyzeLoopback(clipped, reference, 48_000).reason, 'clipped');
});

test('校准严格绑定设备/采样率/档位/环境', () => {
  const key: LoopbackCalibrationKey = {
    inputDeviceId: 'in',
    outputDeviceId: 'out',
    sampleRate: 48_000,
    profile: 'realtime',
    browserMajor: 'Chrome 140',
    osAudioConfig: 'macOS-default',
  };
  const calibration = { key, delayMs: 9, confidence: 0.9, measuredAt: 'now' };
  assert.equal(calibrationMatches(calibration, key), true);
  assert.equal(calibrationMatches(calibration, { ...key, profile: 'balanced' }), false);
  assert.equal(calibrationMatches(calibration, { ...key, sampleRate: 44_100 }), false);
  assert.equal(calibrationMatches(calibration, { ...key, inputDeviceId: 'other-in' }), false);
  assert.equal(calibrationMatches(calibration, { ...key, outputDeviceId: 'other-out' }), false);
  assert.equal(calibrationMatches(calibration, { ...key, browserMajor: 'Chrome 141' }), false);
  assert.equal(calibrationMatches(calibration, { ...key, osAudioConfig: 'Windows-default' }), false);
  // Rig 身份不属于 key，因此单块/箱头变化不会让设备往返结果失效。
  assert.equal('rig' in key, false);
});
