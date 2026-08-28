import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { BUILTIN_CAB_IR_MANIFEST } from '../src/audio/cabIrManifest.ts';
import {
  CUSTOM_CAB_IR_TARGET_TRANSFER_DB,
  calibrateCustomCabIr,
  inspectWav,
} from '../src/audio/cabIrProcessing.ts';

const DEFAULT_LEVEL_DB = {
  open1x12: -1,
  blue2x12: -1.5,
  gb4x12: -2,
  v304x12: -2,
} as const;
const CUSTOM_DEFAULT_LEVEL_DB = -2;

const GOLDENS = {
  open1x12: {
    calibrationDb: -15.909, calibratedBroadbandDb: 1.178, peak: 0.9712081,
    rms: 0.01543974, responseDb: [19.566, 14.696, 3.196],
  },
  blue2x12: {
    calibrationDb: -12.388, calibratedBroadbandDb: 1.573, peak: 0.7160038,
    rms: 0.01195899, responseDb: [9.291, 13.943, 0.237],
  },
  gb4x12: {
    calibrationDb: -16.436, calibratedBroadbandDb: 2.129, peak: 0.9731116,
    rms: 0.01648184, responseDb: [23.913, 9.88, 3.858],
  },
  v304x12: {
    calibrationDb: -13.376, calibratedBroadbandDb: 1.98, peak: 0.8332314,
    rms: 0.01346351, responseDb: [19.196, 11.213, 9.531],
  },
} as const;

function pcm24Metrics(bytes: Buffer): {
  peak: number;
  rms: number;
  samples: number;
  pcm: Float64Array;
} {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === 'data') {
      let peak = 0;
      let sumSquares = 0;
      const samples = size / 3;
      const pcm = new Float64Array(samples);
      for (let index = 0; index < samples; index++) {
        const sampleOffset = offset + 8 + index * 3;
        let sample = bytes[sampleOffset]
          | (bytes[sampleOffset + 1] << 8)
          | (bytes[sampleOffset + 2] << 16);
        if (sample & 0x800000) sample |= 0xff000000;
        const value = sample / 8388608;
        pcm[index] = value;
        peak = Math.max(peak, Math.abs(value));
        sumSquares += value * value;
      }
      return { peak, rms: Math.sqrt(sumSquares / samples), samples, pcm };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('WAV 缺少 data chunk');
}

function responseDb(pcm: Float64Array, sampleRate: number, frequency: number): number {
  const radians = 2 * Math.PI * frequency / sampleRate;
  let real = 0;
  let imaginary = 0;
  for (let index = 0; index < pcm.length; index++) {
    real += pcm[index] * Math.cos(radians * index);
    imaginary -= pcm[index] * Math.sin(radians * index);
  }
  return 10 * Math.log10(real * real + imaginary * imaginary);
}

/** 与校准记录相同的 70Hz–10kHz、1,024 点 pink-power 加权。 */
function pinkWeightedTransferDb(pcm: Float64Array, sampleRate: number): number {
  let weightedPower = 0;
  let weightSum = 0;
  for (let line = 0; line < 1024; line++) {
    const frequency = 70 + (10_000 - 70) * line / 1023;
    const weight = 1 / frequency;
    weightedPower += 10 ** (responseDb(pcm, sampleRate, frequency) / 10) * weight;
    weightSum += weight;
  }
  return 10 * Math.log10(weightedPower / weightSum);
}

for (const entry of BUILTIN_CAB_IR_MANIFEST) {
  test(`bundled Cab IR golden: ${entry.id}`, async () => {
    const bytes = await readFile(new URL(`../public/irs/${entry.file}`, import.meta.url));
    const digest = createHash('sha256').update(bytes).digest('hex');
    const wav = inspectWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const metrics = pcm24Metrics(bytes);
    const golden = GOLDENS[entry.id];

    assert.equal(digest, entry.sha256);
    assert.ok(entry.file.includes(digest.slice(0, 8)), '静态文件名必须带内容 hash');
    assert.deepEqual(
      { channels: wav.channels, sampleRate: wav.sampleRate, bitsPerSample: wav.bitsPerSample },
      { channels: entry.channels, sampleRate: entry.sampleRate, bitsPerSample: entry.bitsPerSample },
    );
    assert.equal(metrics.samples / wav.sampleRate, entry.durationSeconds);
    assert.equal(entry.trimmedFrames, 0);
    assert.equal(entry.calibrationDb, golden.calibrationDb);
    assert.ok(Math.abs(metrics.peak - golden.peak) < 1e-6);
    assert.ok(Math.abs(metrics.rms - golden.rms) < 1e-6);
    for (const [index, frequency] of [100, 1000, 5000].entries()) {
      assert.ok(Math.abs(responseDb(metrics.pcm, wav.sampleRate, frequency) - golden.responseDb[index]) < 0.01);
    }
    const calibratedBroadbandDb = pinkWeightedTransferDb(metrics.pcm, wav.sampleRate) + entry.calibrationDb;
    assert.ok(Math.abs(calibratedBroadbandDb - golden.calibratedBroadbandDb) < 0.01);
    assert.ok(metrics.peak * 10 ** (entry.calibrationDb / 20) < 0.2, '校准后单位脉冲峰值必须保留余量');

    const customCalibration = calibrateCustomCabIr({
      channels: [Float32Array.from(metrics.pcm)],
      sampleRate: wav.sampleRate,
      durationSeconds: metrics.samples / wav.sampleRate,
      trimmedFrames: 0,
      peak: metrics.peak,
    });
    assert.equal(customCalibration.limited, false);
    assert.ok(
      Math.abs(customCalibration.calibratedTransferDb - CUSTOM_CAB_IR_TARGET_TRANSFER_DB) < 0.02,
      'Custom IR 应对齐统一的加权传递增益',
    );
    const builtinDefaultOutputDb = calibratedBroadbandDb + DEFAULT_LEVEL_DB[entry.id];
    const customDefaultOutputDb = customCalibration.calibratedTransferDb + CUSTOM_DEFAULT_LEVEL_DB;
    assert.ok(
      Math.abs(builtinDefaultOutputDb - customDefaultOutputDb) <= 0.5,
      '同一 WAV 作为内置或 Custom 加载时，默认输出应在 ±0.5dB 内',
    );
  });
}
