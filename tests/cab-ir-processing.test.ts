import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CabIrError,
  CUSTOM_CAB_IR_CALIBRATION_DB_MAX,
  CUSTOM_CAB_IR_MAX_CALIBRATED_PEAK,
  calibrateCustomCabIr,
  inspectWav,
  preprocessCabIr,
  type DecodedCabIr,
} from '../src/audio/cabIrProcessing.ts';

function wavHeader({ channels = 2, sampleRate = 48_000, bits = 24 } = {}): ArrayBuffer {
  const bytesPerSample = bits / 8;
  const dataLength = channels * bytesPerSample * 8;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, bits, true);
  text(36, 'data');
  view.setUint32(40, dataLength, true);
  return buffer;
}

function decoded(channels: number[][], sampleRate = 48_000): DecodedCabIr {
  const arrays = channels.map((values) => Float32Array.from(values));
  return {
    numberOfChannels: arrays.length,
    length: arrays[0]?.length ?? 0,
    sampleRate,
    duration: (arrays[0]?.length ?? 0) / sampleRate,
    getChannelData: (channel) => arrays[channel],
  };
}

test('inspectWav reads original channel/rate/bit metadata and rejects non-WAV', () => {
  assert.deepEqual(inspectWav(wavHeader({ channels: 2, sampleRate: 44_100, bits: 24 })), {
    channels: 2,
    sampleRate: 44_100,
    bitsPerSample: 24,
    audioFormat: 1,
  });
  assert.throws(() => inspectWav(new TextEncoder().encode('not wav').buffer), CabIrError);
});

test('preprocessCabIr trims common leading silence at -80 dB with 0.5 ms preroll', () => {
  const length = 80;
  const left = new Array<number>(length).fill(0);
  const right = new Array<number>(length).fill(0);
  left[40] = 1;
  right[50] = 0.5;

  const result = preprocessCabIr(decoded([left, right], 48_000));

  assert.equal(result.trimmedFrames, 16, 'first active frame 40 minus 24-frame preroll');
  assert.equal(result.channels.length, 2);
  assert.equal(result.channels[0].length, 64);
  assert.equal(result.channels[0][24], 1);
  assert.equal(result.channels[1][34], 0.5);
});

test('preprocessCabIr rejects silent, non-finite, >2s and non-mono/stereo decodes', () => {
  assert.throws(() => preprocessCabIr(decoded([[0, 0], [0, 0]])), /静音/);
  assert.throws(() => preprocessCabIr(decoded([[0, Number.NaN, 1]])), /非有限/);
  assert.throws(
    () => preprocessCabIr(decoded([new Array(96_001).fill(0).map((_, i) => (i === 0 ? 1 : 0))])),
    /2 秒/,
  );
  assert.throws(() => preprocessCabIr(decoded([[1], [1], [1], [1]])), /单声道或双声道/);
});

test('custom IR calibration is deterministic and limits excessive boost and impulse peak', () => {
  const quiet = preprocessCabIr(decoded([[0.001, ...new Array(2047).fill(0)]]));
  const quietCalibration = calibrateCustomCabIr(quiet);
  assert.equal(quietCalibration.calibrationDb, CUSTOM_CAB_IR_CALIBRATION_DB_MAX);
  assert.equal(quietCalibration.limited, true);

  const fullScale = preprocessCabIr(decoded([[1, ...new Array(2047).fill(0)]]));
  const fullScaleCalibration = calibrateCustomCabIr(fullScale);
  assert.ok(fullScaleCalibration.calibratedPeak <= CUSTOM_CAB_IR_MAX_CALIBRATED_PEAK + 1e-9);
  assert.equal(fullScaleCalibration.limited, true);
  assert.deepEqual(calibrateCustomCabIr(fullScale), fullScaleCalibration);
});
