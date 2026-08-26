import assert from 'node:assert/strict';
import test from 'node:test';
import {
  audioContextOptions,
  fallbackMicConstraints,
  loadAudioProfile,
  preferredMicConstraints,
  openMicWithFallback,
  saveAudioProfile,
  type AudioInputConstraints,
} from '../src/audio/audioProfile.ts';

test('音频档位映射到诚实的 Context 与 mic 请求', () => {
  assert.deepEqual(audioContextOptions('realtime'), { latencyHint: 'interactive', sampleRate: 48_000 });
  assert.deepEqual(audioContextOptions('balanced'), { latencyHint: 'balanced', sampleRate: 48_000 });
  assert.deepEqual(audioContextOptions('stable'), { latencyHint: 'playback', sampleRate: 48_000 });

  const preferred = preferredMicConstraints('balanced', 'mic-1').audio as AudioInputConstraints;
  assert.deepEqual(preferred.deviceId, { exact: 'mic-1' });
  assert.deepEqual(preferred.latency, { ideal: 0.02 });
  assert.deepEqual(preferred.sampleRate, { ideal: 48_000 });
  assert.deepEqual(preferred.channelCount, { ideal: 1 });
  assert.equal(preferred.echoCancellation, false);
  assert.equal(preferred.noiseSuppression, false);
  assert.equal(preferred.autoGainControl, false);

  const fallback = fallbackMicConstraints('mic-1').audio as MediaTrackConstraints;
  assert.equal('latency' in fallback, false);
  assert.equal('sampleRate' in fallback, false);
  assert.equal('channelCount' in fallback, false);
  assert.equal(fallback.echoCancellation, false);
  assert.equal(fallback.noiseSuppression, false);
  assert.equal(fallback.autoGainControl, false);
});

test('首选输入失败后只移除可选约束，绝不恢复语音处理', async () => {
  const calls: MediaStreamConstraints[] = [];
  const stream = {} as MediaStream;
  const getUserMedia = async (constraints: MediaStreamConstraints) => {
    calls.push(constraints);
    if (calls.length === 1) throw new Error('unsupported constraints');
    return stream;
  };
  const result = await openMicWithFallback(getUserMedia, 'balanced', 'mic-1');
  assert.equal(result.stream, stream);
  assert.equal(result.degraded, true);
  assert.equal(calls.length, 2);
  const fallback = calls[1].audio as MediaTrackConstraints;
  assert.equal('latency' in fallback, false);
  assert.equal('sampleRate' in fallback, false);
  assert.equal('channelCount' in fallback, false);
  assert.equal(fallback.echoCancellation, false);
  assert.equal(fallback.noiseSuppression, false);
  assert.equal(fallback.autoGainControl, false);
});

test('音频档位本地持久化且坏值回退 realtime', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
  assert.equal(loadAudioProfile(storage), 'realtime');
  saveAudioProfile('stable', storage);
  assert.equal(loadAudioProfile(storage), 'stable');
  values.set('guitar-pedalboard-audio-profile-v1', 'not-a-profile');
  assert.equal(loadAudioProfile(storage), 'realtime');
});
