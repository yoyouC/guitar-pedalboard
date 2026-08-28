import assert from 'node:assert/strict';
import test from 'node:test';
import { CabIrBufferResolver } from '../src/audio/cabIrRuntime.ts';
import { sha256Hex } from '../src/audio/cabIrProcessing.ts';
import type { StoredCabIr } from '../src/audio/cabIrCoordinator.ts';
import { createStubAudioContext } from './helpers/stub-audio-context.ts';

function wavBytes(sampleFrames = 2048): ArrayBuffer {
  const dataLength = sampleFrames * 2;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 48_000, true);
  view.setUint32(28, 96_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, dataLength, true);
  return buffer;
}

test('legacy Custom IR computes calibration once and persists it through the resolver seam', async () => {
  const bytes = wavBytes();
  const hash = await sha256Hex(bytes);
  const samples = new Float32Array(2048);
  samples[0] = 0.1;
  samples[24] = 0.08;
  const decoded = {
    numberOfChannels: 1,
    length: samples.length,
    sampleRate: 48_000,
    duration: samples.length / 48_000,
    getChannelData: () => samples,
  };
  const ctx = createStubAudioContext();
  (ctx as unknown as { decodeAudioData(bytes: ArrayBuffer): Promise<typeof decoded> }).decodeAudioData
    = async () => decoded;
  const legacy: StoredCabIr = {
    hash,
    name: 'legacy.wav',
    blob: new Blob([bytes]),
    bytes: bytes.byteLength,
    channels: 1,
    originalSampleRate: 48_000,
    processedSampleRate: 48_000,
    durationSeconds: decoded.duration,
    trimmedFrames: 0,
    createdAt: 1,
    lastUsedAt: 1,
  };
  const saved: Array<{ hash: string; calibrationDb: number }> = [];
  const resolver = new CabIrBufferResolver();
  resolver.setCustomLoader(
    async () => legacy,
    async (savedHash, calibrationDb) => { saved.push({ hash: savedHash, calibrationDb }); },
  );

  const resolved = await resolver.resolve(
    ctx as unknown as AudioContext,
    { kind: 'custom', hash },
  );

  assert.equal(Number.isFinite(resolved.calibrationDb), true);
  assert.deepEqual(saved, [{ hash, calibrationDb: resolved.calibrationDb }]);
  assert.ok(Math.abs(resolved.buffer.getChannelData(0)[0] - 0.1) < 1e-6);
});
