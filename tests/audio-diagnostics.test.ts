import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LatencyWindow,
  createDiagnosticExport,
  latencyBand,
  type AudioDiagnosticsSnapshot,
} from '../src/audio/audioDiagnostics.ts';

test('五点滑窗返回中位数与范围并可清空', () => {
  const window = new LatencyWindow(5);
  for (const value of [12, 8, 30, 10, 9, 7]) window.push(value);
  assert.deepEqual(window.snapshot(), { medianMs: 9, minMs: 7, maxMs: 30, samples: 5 });
  assert.deepEqual(window.clear(), { medianMs: null, minMs: null, maxMs: null, samples: 0 });
});

test('输出估算颜色门槛只解释自身指标', () => {
  assert.equal(latencyBand(null), 'unknown');
  assert.equal(latencyBand(10), 'good');
  assert.equal(latencyBand(10.01), 'warn');
  assert.equal(latencyBand(20), 'warn');
  assert.equal(latencyBand(20.01), 'bad');
});

test('诊断导出默认不含设备名称且使用字段白名单', () => {
  const snapshot = {
    ready: false,
    runtimeVersion: 0,
    profile: 'realtime',
    profileIgnored: false,
    degradedInput: false,
    workletFailures: [],
    warning: null,
    baseLatencyMs: null,
    outputLatencyMs: null,
    outputEstimate: { medianMs: null, minMs: null, maxMs: null, samples: 0 },
    sampleRate: null,
    inputSettings: {
      deviceId: 'secret-device-id',
      groupId: 'secret-group-id',
      sampleRate: 48_000,
      channelCount: 1,
    },
    playback: {
      supported: false,
      underrunEvents: null,
      underrunDurationMs: null,
      averageLatencyMs: null,
      minimumLatencyMs: null,
      maximumLatencyMs: null,
    },
    mainThread: { supported: false, longTaskCount: 0, longTaskDurationMs: 0 },
    stabilityObservation: null,
    rigLatency: null,
    calibrationMs: null,
  } satisfies AudioDiagnosticsSnapshot;
  const base = {
    snapshot,
    appVersion: 'test',
    browser: 'Chrome 1',
    os: 'macOS',
    rigComplexity: { pedals: 2, namModules: 1, wdfModules: 1 },
    inputDeviceLabel: 'Secret input',
    outputDeviceLabel: 'Secret output',
  };
  assert.equal('devices' in createDiagnosticExport(base), false);
  assert.equal(JSON.stringify(createDiagnosticExport(base)).includes('secret'), false);
  assert.deepEqual(createDiagnosticExport({ ...base, includeDeviceNames: true }).devices, {
    input: 'Secret input',
    output: 'Secret output',
  });
});
