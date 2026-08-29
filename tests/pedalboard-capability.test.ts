import assert from 'node:assert/strict';
import test from 'node:test';
import { detectPedalboardCapability } from '../src/marketplace/pedalboardCapability.ts';

const supported = {
  isSecureContext: true,
  AudioContext: class {},
  AudioWorkletNode: class {},
  mediaDevices: { getUserMedia() {} },
};

test('Pedalboard access follows browser audio capability, not viewport width', () => {
  assert.equal(detectPedalboardCapability({ ...supported, viewportWidth: 360 } as typeof supported).supported, true);
  assert.equal(detectPedalboardCapability({ ...supported, viewportWidth: 1440 } as typeof supported).supported, true);
});

test('missing audio runtime capabilities disable Pedalboard with exact reasons', () => {
  assert.deepEqual(detectPedalboardCapability({
    isSecureContext: false,
    mediaDevices: {},
  }), {
    supported: false,
    missing: ['secure-context', 'audio-context', 'audio-worklet', 'microphone'],
  });
});
